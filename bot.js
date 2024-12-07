require('dotenv').config();
const { Chat, Api } = require("twitch-js");
const TwitchPS = require('twitchps');
const pg = require('pg');
const { remove: diacritics } = require('diacritics');

const SCOPES = [
	'chat:read',
	'chat:edit',
	'channel:read:redemptions',
	//'channel:manage:redemptions',
	//'moderator:manage:announcements',
];

const channels = {};

// Create Twitch Client
// To generate tokens, use https://twitchtokengenerator.com.
const chat = new Chat({
  username: process.env.BOT_NICK,
  token: process.env.TMI_TOKEN
});

const ps = new TwitchPS({init_topics: [{ topic: `video-playback.questionspourunbot` }], reconnect: false, debug: true});

// Connect to Prostgres
const pgClient = new pg.Client({
	host: process.env.PGHOST,
	port: process.env.PGPORT,
	database: process.env.PGDATABASE,
	user: process.env.PGUSER,
	password: process.env.PGPASSWORD
});

class Channel {
	constructor(id) {
		this.id = id;
		this.cooldowns = {};
		this.api = false;
	}

	get channelName() {
		return `#${this.name}`;
	}

	get prefixRegex() {
		return new RegExp(`^(@${process.env.BOT_NICK}|${this.prefix})`, 'i');
	}

	async validateToken() {
		if (!this.user_token) return console.error('Token not set');
		const ret = await fetch('https://id.twitch.tv/oauth2/validate', {
			headers: {
				'Authorization': `Bearer ${this.user_token}`
			}
		})
			.then(res => res.json())
			.catch(console.error);
		if (!(ret?.status !== 401)) {
			console.error(`Token invalide pour ${this.name} (${this.id}). Régénérer un token en accédant à https://gw2trivia.com/qpub/token`);
			pgClient.query('UPDATE qpub.channels SET invalid_token = TRUE WHERE room_id = $1', [this.id]);
			throw new Error('Invalid Token');
		}
		return true;
	}

	async fetch() {
		const { rows, rowCount } = await pgClient.query('SELECT * FROM qpub.channels WHERE room_id = $1', [this.id]);

		if (rowCount === 0) {
			console.error('Aucun channel n\'a été trouvé.');
			throw new Error('Channel not found');
		}
		Object.assign(this, rows[0]);
		if (this.user_token) {
			this.api = new Api({
				clientId: process.env.CLIENT_ID,
				token: this.user_token
			});
			await this.validateToken(); // throws "Invalid Token"
			const user = await this.api.get('users')
			.then(console.log);
			if (!this.custom_reward_id) await this.createQuizReward(); // TODO: verify if broadcaster_type is affiliate / patrner
			this.api.get('channel_points/custom_rewards', {
				search: {
					broadcaster_id: `${this.room_id}`
				}
			  }).then(console.log)
			ps.addTopic([{ topic: `channel-points-channel-v1.${this.room_id}`, token: this.user_token }, { topic: `video-playback.${this.name}` }]);
		}
	}

	clear() {
		delete this.question;
	}

	hasCooldown(name) {
		return name in this.cooldowns;
	}

	setCooldown(name, duration = 900) {
		this.cooldowns[name] = new CoolDown(duration);
		setTimeout(() => {
			delete this.cooldowns[name];
		}, this.cooldowns[name].timeleft);
	}

	async createQuizReward() {
		this.api.post('channel_points/custom_rewards', {
			search: {
				broadcaster_id: this.id
			},
			body: {
				title: 'Question pour un Quaggan',
				cost: 100,
				is_global_cooldown_enabled: true,
				global_cooldown_seconds: 30 * 60
			}
		}).then(async response => {
			console.log(response);
			const { id } = response.data[0];
			await pgClient.query('UPDATE qpub.channels SET custom_reward_id = $1 WHERE room_id = $2', [id, this.id]);
			this.custom_reward_id = id;
		})
		.catch(console.error);
	}

	async quiz(client, context = {}, args = []) {
		console.log(this.name);
		if (this.question) {
			client.say(this.name, `⏳ Une question est déjà en cours : ${this.question.question}`);
			return;
		}
		if (this.hasCooldown('quiz')) {
			
		}
		const question = new Question(this);
		await question.fetch();
		console.log(args);
		const duration = (args.length > 0 ? Number(args[0]) : 900) * 1000;
		this.question = {
			question,
			timeout: setTimeout(() => {
				client.say(this.name, "❎ Personne n'a trouvé.");
				question.stop();
				delete this.question;
			}, duration)
		}

		console.log(question.answers);

		client.say(this.name, question.toString());
	}

	checkAnswer(message, context) {
		if (!this.question) return;
		const { question, timeout } = this.question;
		console.log(question);
		if (question.checkAnswer(message)) {
			chat.say(this.channelName, `✅ @${context.username} a trouvé la bonne réponse et a gagné ${question.points} point(s) !`);
			clearTimeout(timeout);
			question.stop(context, message);
			delete this.question;
		}
	}

	async top(client, context = {}, args = []) {
		const { roomId } = context.tags;
		const { rowCount: scoreCount, rows: scoreRows } = await pgClient.query('SELECT * FROM qpub.scores where channel_id = $1 ORDER BY points DESC', [roomId]);

		const scores = await Promise.all(scoreRows.map(async r => {
			const { user_id, points } = r;
			const name = await this.api.get('users', {
				search: { id: user_id }
			}).then(response => response.data ? response.data[0].displayName : '.');
			return `${name} : ${points} point(s)`;
		}));
		client.say(this.name, ['Scores :', ...scores].join('\n'));
	}

	checkPrefix(message) {
		return this.prefixRegex.test(message);
	}

	cleanPrefix(message) {
		return message.replace(this.prefixRegex, '');
	}

	static async instance(id) {
		if (!(id in channels)) {
			const channel = new Channel(id);
			await channel.fetch();
			channels[id] = channel;
		}
		return channels[id];
	}
}

class Question {
	constructor(channel, id = false) {
		this.channel = channel;
		this.id = id;
	}

	async fetch() {
		let where = 'WHERE i.image_id IS NULL';
		let offset = '';
		if (this.id) {
			where = `${where} AND q.id=${this.id}`;
		} else {
			let { rows: r } = await pgClient.query(`SELECT COUNT(*) FROM gw2trivia.questions q LEFT JOIN gw2trivia.images_questions_rel i ON i.question_id = q.id ${where}`);
			offset = `OFFSET ${Math.floor(Math.random() * r[0].count)} LIMIT 1`;
		}
		let { rowCount, rows } = await pgClient.query(`SELECT q.*, array_agg(a.content) AS answers 
		FROM gw2trivia.questions q 
		INNER JOIN gw2trivia.answers a ON a.question_id = q.id 
		LEFT JOIN gw2trivia.images_questions_rel i ON i.question_id = q.id
		${where}
		GROUP BY q.id ${offset}`);
		if (rowCount === 0) {
			chat.say(target, 'Aucune question n\'a été trouvée.');
			return;
		}
		Object.assign(this, rows[0]);
	}

	toString() {
		return `${this.title} (${this.points} point(s))`;
	}

	checkAnswer(answer) {
		return this.answers
            .some(ans => ans.split(/\s*;\s*/)
                .every(str => new RegExp(diacritics(str.trim()).replace(/ /g, '.*').replace(/[’'-]/g, '.'), "gi").test(diacritics(answer).replace(/-/g, ' '))));
	}

	async stop(context = false, message = '') {
		if (!context) {
			await pgClient.query(`INSERT INTO qpub.participations (room_id, question_id, date, points) VALUES (${this.channel.room_id}, ${this.id}, NOW(), ${this.points})`);
		} else {
			const { roomId, userId } = context.tags;
			await pgClient.query(`INSERT INTO qpub.participations (room_id, question_id, user_id, answer, date, points) VALUES (${roomId}, ${this.id}, ${userId}, $1, NOW(), ${this.points})`, [message]);
			const { rowCount: scoreCount, rows: scoreRows } = await pgClient.query('SELECT * FROM qpub.scores where channel_id = $1 AND user_id = $2', [roomId, userId]);
			if (scoreCount === 0) {
				await pgClient.query('INSERT INTO qpub.scores (channel_id, user_id, points) VALUES ($1, $2, $3)', [roomId, userId, this.points]);
			} else {
				const current = scoreRows[0].points;
				await pgClient.query('UPDATE qpub.scores SET points = $1 WHERE channel_id = $2 AND user_id = $3', [this.points + current, roomId, userId]);
			}
		}
	}
}

class CoolDown {
	constructor(duration, date = new Date()) {
		this.start = date;
		this.duration = duration;
		this.end = this.start.setSeconds(this.start.getSeconds() + duration);
	}

	isEnded() {
		return new Date() >= this.end;
	}

	/*
	 * @returns: time left in milliseconds
	 */
	get timeleft() {
		return this.end.getTime() - (new Date()).getTime();
	}
}

const joinChannel = async (chat, channel, roomId) => {
	const channelState = await chat.join(channel);
	await Channel.instance(roomId).catch(err => {
		console.error(err);
		// TODO: leave chat
		throw err;
	});
	console.log('joined');
	console.log(channelState);
};

// Called every time a message comes in
const onMessageHandler = async ({message, isSelf, ...context}) => {
	if (isSelf) return; // Ignore messages from the bot
	const channel = await Channel.instance(context.tags.roomId);
	// check if answer of an ongoing quiz
	channel.checkAnswer(message, context);
	if (!channel.checkPrefix(message)) return; // Ignore messages not addressed to the bot
  
	message = channel.cleanPrefix(message);
  
	// Remove whitespace from chat message and fetch arguments
	const args = message.trim().split(' ');
	const command = args.shift().toLowerCase();
  
	// If the command is known, let's execute it
	if (commands.hasOwnProperty(command)) {
	  await commands[command](chat, channel.channelName, context, args);
	  console.log(`* Executed ${command} command`);
	} else {
	  console.log(`* Unknown command ${command}`);
	}
};

const commands = {
	dice: async (client, target, context, args) => {
		const sides = 6;
		const num = Math.floor(Math.random() * sides) + 1;
		client.say(target, `🎲 @${context.username} a lancé un dé et a obtenu ${num}`);
	},
	ping: async (client, target, context, args) => {
		client.say(target, 'Pong!');
	},
	quiz: async (client, target, context, args) => {
		//if (!context.mod) return;
		const channel = await Channel.instance(context.tags.roomId);
		await channel.quiz(client, context, args);
	},
	top: async (client, target, context, args) => {
		//if (!context.mod) return;
		const channel = await Channel.instance(context.tags.roomId);
		await channel.top(client, context, args);
	}
};

// Listen to Twitch events
chat.on('PRIVMSG', onMessageHandler);

ps.on('stream-up', ({time, channel_name, play_delay}) => console.log('Stream up'));
ps.on('stream-down', ({time, channel_name}) => console.log('Stream down'));
ps.on('reward-redeemed', ({timestamp, redemption, channel_id, redeemed_at, reward, status, ...data}) => console.log('Redemption! Reward: ', reward));
ps.on('channel-points', async ({timestamp, redemption, channel_id, redeemed_at, reward, status, ...data}) => {
	console.log('Points! Reward: ',channel_id, redemption, reward);
	const channel = await Channel.instance(channel_id);
	if (reward.id !== channel.custom_reward_id) return;
	channel.quiz(chat);
	channel.api.get('channel_points/custom_rewards/redemptions', {
		search: {
			id: redemption.id,
			broadcaster_id: channel_id,
			reward_id: reward.id,
			status: 'UNFULFILLED'
		}
	}).then(console.log).catch(console.error);
	console.log('Request', 'channel_points/custom_rewards/redemptions', {
		id: redemption.id,
		broadcaster_id: channel_id,
		reward_id: reward.id
	},{
		status: 'FULFILLED'
	});
	channel.api.get('channel_points/custom_rewards/redemptions', {
		search: {
			id: redemption.id,
			broadcaster_id: channel_id,
			reward_id: reward.id
		},
		body: {
			status: 'FULFILLED'
		},
		method: 'patch'
	}).catch(console.error);
});

// Connect the clients and join the channels
const run = async () => {
	pgClient.connect();

  const { rows, rowCount } = await pgClient.query('SELECT room_id, name FROM qpub.channels');

  if (!rowCount) return;

  await chat.connect();
  await Promise.all(rows.map(row => joinChannel(chat, row.name, row.room_id).catch(err => console.error(`Cannot connect to ${row.name}`))));
};

run();
