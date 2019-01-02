const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { exec } = require('child_process');
const VideoLib = require('node-video-lib');
const TelegramBot = require('node-telegram-bot-api');
const { google } = require('googleapis');

const { OAuth2 } = google.auth;

const SCOPES = ['https://www.googleapis.com/auth/youtube.readonly'];
const TOKEN_DIR = path.join(__dirname, '.credentials');
const TOKEN_PATH = path.join(TOKEN_DIR, 'yt-bot.json');

const TG_CREDENTIALS = JSON.parse(fs.readFileSync(path.join(TOKEN_DIR, 'telegram.json')));
const CHATID = TG_CREDENTIALS.chatId;
const bot = new TelegramBot(TG_CREDENTIALS.token, { polling: true });

Array.prototype.flat = function flat() {
  return this.reduce((a, b) => [...a, ...b], []);
};

Array.prototype.contains = function contains(compare) {
  return this.indexOf(compare) !== -1;
};

function errHandler(err, txt) {
  const msg = `Error ${txt}: ${err}`;
  console.log(msg);
  if (bot && CHATID) {
    bot.sendMessage(CHATID, msg);
  }
  process.exit();
}

function readFile(filePath) {
  return new Promise((resolve, reject) => {
    fs.readFile(filePath, (err, content) => {
      if (err) reject(err);
      else resolve(content);
    });
  });
}

function openFile(filePath) {
  return new Promise((resolve, reject) => {
    fs.open(filePath, 'r', (err, fd) => {
      if (err) reject(err);
      else resolve(fd);
    });
  });
}

function getVideoId(url) {
  return url
    .replace(/https?:\/\/(www\.)?youtu\.?be(.com)?\/(watch\?v=)?/, '')
    .replace(/&.*/, '')
    .replace(/\?.*/, '');
}

function storeToken(token) {
  try {
    fs.mkdirSync(TOKEN_DIR);
  } catch (err) {
    if (err.code !== 'EEXIST') {
      errHandler(err, `while trying to store the OAuth token on ${TOKEN_DIR}`);
    }
  }
  fs.writeFile(TOKEN_PATH, JSON.stringify(token), (err) => {
    if (err) errHandler(err, `while trying to store the OAuth token on ${TOKEN_PATH}`);
  });
  console.log(`Token stored to ${TOKEN_PATH}`);
}

async function getNewToken(oauth2Client) {
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
  });
  console.log('Authorize this app by visiting this url: ', authUrl);

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const token = await new Promise((resolve, reject) => {
    rl.question('Enter the code from that page here: ', (code) => {
      rl.close();
      oauth2Client.getToken(code, (err, tk) => {
        if (err) reject(err);
        else resolve(tk);
      });
    });
  }).catch(err => errHandler(err, 'while trying to retrieve access token'));

  storeToken(token);
  return token;
}

async function authorize(credentials) {
  const { client_secret, client_id, redirect_uris } = credentials.installed;
  const oauth2Client = new OAuth2(client_id, client_secret, redirect_uris[0]);

  const token = await readFile(TOKEN_PATH)
    .then(tk => JSON.parse(tk))
    .catch(() => getNewToken(oauth2Client));
  oauth2Client.credentials = token;
  return oauth2Client;
}

async function iterateResults(ytFun, payload) {
  let acc = 0;
  let total = 1;
  let data = [];
  while (acc < total) {
    const response = await new Promise((resolve, reject) => {
      ytFun(payload, (err, res) => {
        if (err) reject(err);
        else resolve(res);
      });
    })
      .then(res => res.data)
      .catch(err => errHandler(err, 'while fetching data from the API'));
    total = response.pageInfo.totalResults;
    acc += response.pageInfo.resultsPerPage;
    payload.pageToken = response.nextPageToken;
    data = [...data, ...response.items];
  }
  return data;
}

async function getSubscriptions(service, auth) {
  return (await iterateResults(service.subscriptions.list, {
    auth,
    part: 'snippet',
    mine: true,
    maxResults: 50,
  })).map(subscription => subscription.snippet.resourceId.channelId);
}

async function getUploadsPlaylist(service, auth, subscriptions) {
  return (await iterateResults(service.channels.list, {
    auth,
    id: subscriptions.join(','),
    part: 'contentDetails',
    maxResults: 50,
  })).map(details => details.contentDetails.relatedPlaylists.uploads);
}

async function getVideos(service, auth, uploads) {
  return (await Promise.all(
    uploads.map(playlistId => new Promise((resolve, reject) => {
      service.playlistItems.list(
        {
          auth,
          playlistId,
          part: 'contentDetails',
          maxResults: 10,
        },
        (err, response) => {
          if (err) reject(err);
          else resolve(response);
        },
      );
    })
      .then(content => content.data.items.map(video => video.contentDetails.videoId))
      .catch(err => errHandler(err, 'while fetching the videos'))),
  )).flat();
}

async function downloadVideo(url, resolution) {
  return new Promise((resolve, reject) => {
    exec(
      `$(cd ${__dirname} && pipenv --venv)/bin/python ${path.join(
        __dirname,
        'main.py',
      )} ${resolution} ${url}`,
      (err, stdout, stderr) => {
        if (err) reject(`${err}\n\nstdout: ${stdout}\n\nstderr: ${stderr}`);
        else resolve();
      },
    );
  });
}

function getVideoPath(id) {
  return new Promise((resolve, reject) => {
    const downloads = path.join(__dirname, 'downloads');
    fs.readdir(downloads, (err, items) => {
      if (err) reject(err);
      items = items.filter(video => video.includes(id));
      if (items.length > 0) resolve(path.join(downloads, items[0]));
      else reject('Video not found');
    });
  });
}

function splitVideo(videoPath) {
  const size = fs.statSync(videoPath).size / 1000000;
  if (size < 50) return Promise.resolve([videoPath]);

  return openFile(videoPath).then((fd) => {
    const movie = VideoLib.MovieParser.parse(fd);
    const duration = movie.relativeDuration();
    const fragmentList = VideoLib.FragmentListBuilder.build(movie, 30 * (duration / size));
    const parts = [];
    for (let i = 0; i < fragmentList.count(); i++) {
      const fragment = fragmentList.get(i);
      const sampleBuffers = VideoLib.FragmentReader.readSamples(fragment, fd);
      const buffer = VideoLib.HLSPacketizer.packetize(fragment, sampleBuffers);
      const partPath = videoPath.replace(/(\..{1,5})$/, `_part${i}$1`);
      fs.writeFileSync(partPath, buffer);
      parts.push(partPath);
    }
    fs.closeSync(fd);
    fs.unlinkSync(videoPath);
    return parts;
  });
}

async function sendVideo(url, reply_to_message_id, resolution) {
  const video = getVideoId(url);
  downloadVideo(url, resolution)
    .then(() => getVideoPath(video))
    .then(splitVideo)
    .then(parts => Promise.all(
      parts.map(videoPart => bot.sendDocument(CHATID, videoPart, { reply_to_message_id })),
    ).then(() => parts))
    .then(parts => parts.forEach(part => fs.unlinkSync(part)))
    .catch(err => errHandler(err, 'while calling python download or sending video to TG'));
}

async function main() {
  const secret = await readFile(path.join(TOKEN_DIR, 'client_secret.json'))
    .then(content => JSON.parse(content))
    .catch(e => errHandler(e, 'loading client secret file'));
  const oauth = await authorize(secret);
  const service = google.youtube('v3');
  const subscriptions = await getSubscriptions(service, oauth);
  const uploads = await getUploadsPlaylist(service, oauth, subscriptions);
  const videos = await getVideos(service, oauth, uploads);
  const historyPath = path.join(__dirname, 'history.txt');
  const history = fs
    .readFileSync(historyPath)
    .toString()
    .split(/\n/);
  videos.forEach(async (video) => {
    if (!history.contains(video)) {
      const url = `https://www.youtube.com/watch?v=${video}`;
      const { message_id } = await bot.sendMessage(CHATID, url);
      sendVideo(url, message_id, 480);
    }
  });
  fs.writeFileSync(historyPath, videos.join('\n'));
}

bot.onText(/(https?:\/\/(www\.)?youtu\.?be(.com)?\/(watch\?v=)?\S{11})(&.*)?/, (msg, match) => {
  const video = match[1];
  bot.sendMessage(msg.chat.id, 'Downloading...', { reply_to_message_id: msg.message_id });
  sendVideo(video, msg.message_id, 480);
});

bot.onText(/\/hd/, (msg) => {
  if (!msg.reply_to_message) {
    bot.sendMessage(msg.chat.id, 'The command must be a reply to a YT video URL message', {
      reply_to_message_id: msg.message_id,
    });
    return;
  }
  bot.sendMessage(msg.chat.id, 'Redownloading at 720p', { reply_to_message_id: msg.message_id });
  const original = msg.reply_to_message;
  const video = original.text;
  sendVideo(video.replace(/&.*/, ''), original.message_id, 720);
});

bot.onText(/\/resize (.*)/, (msg, match) => {
  if (!msg.reply_to_message) {
    bot.sendMessage(msg.chat.id, 'The command must be a reply to a YT video URL message', {
      reply_to_message_id: msg.message_id,
    });
    return;
  }
  const resolution = match[1];
  bot.sendMessage(msg.chat.id, `Redownloading at ${resolution}`, {
    reply_to_message_id: msg.message_id,
  });
  const video = msg.reply_to_message.text;
  sendVideo(video.replace(/&.*/, ''), msg.message_id, resolution);
});

main();
setInterval(main, 2.5 * 60 * 1000);
