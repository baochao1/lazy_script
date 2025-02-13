/**
 * @description app 通用调用方法
 */

const _ = require('lodash');
const path = require('path');
const fs = require('fs');
const {getLogFile, sleep, parallelRun} = require('./lib/common');
const {getNowDate, getMoment} = require('./lib/moment');
const {getCookieData} = require('./lib/env');
const {doPolling} = require('./lib/cron');
const serverChan = require('./lib/serverChan');
const mailer = require('./lib/mailer');
const TemporarilyOffline = {start: _.noop, cron: _.noop, getName: () => 'TemporarilyOffline'};

let errorOutput = [];

async function multipleRun(targets, onceDelaySecond = 1) {
  return parallelRun({
    list: targets,
    runFn: item => doRun(..._.concat(item)),
    onceDelaySecond,
  });
}

async function serialRun(targets, runFn = doRun) {
  for (const target of _.concat(targets)) {
    await doPolling({
      beforePollFn: () => runFn(..._.concat(target)),
      totalTime: 30 * 6,
    });
  }
}

async function doRun(target, cookieData = getCookieData(target.scriptName), method = 'start') {
  const name = target.getName();
  const timeLabel = `[${getMoment().format('YYYY-MM-DD HH:mm:ss.SSS')}] [${name}] do ${method}`;
  console.time(timeLabel);
  let result;
  try {
    result = await target[method](cookieData);
  } catch (e) {
    errorOutput.push(`[${name}] error:`);
    errorOutput.push(e.stack);
    errorOutput.push('----------------------');
    console.error(e);
  }
  console.timeEnd(timeLabel);
  return result;
}

async function doCron(target, cookieData = getCookieData()) {
  return doRun(target, cookieData, 'cron');
}

// 本地测试
async function doRun1(target, index = 0, needScriptName = false) {
  await doRun(target, getCookieData(needScriptName ? target.scriptName : void 0)[index]);
}

async function doCron1(target, index = 0) {
  await doCron(target, getCookieData()[index]);
}

async function sendNotify({sendYesterdayLog = false, subjects = []}) {
  const getFileContent = filePath => fs.existsSync(filePath) ? fs.readFileSync(filePath) : '';
  const resultContent = getFileContent(path.resolve(__dirname, '../dist/result.txt'));
  const contents = [];
  if (sendYesterdayLog) {
    const yesterdayLog = getLogFile('app', getMoment().subtract(1, 'd').format('YYYY-MM-DD'));
    contents.push(getFileContent(yesterdayLog));
    contents.push(`${getNowDate()}-start--------------------------\n`);
  }
  contents.push(getFileContent(getLogFile('app')));
  contents.push(resultContent);

  const [mainSubject = 'lazy_script', ...otherSubject] = subjects;
  const getSubject = (str = mainSubject) => [str].concat(otherSubject).join('_');

  if (!_.isEmpty(errorOutput)) {
    mailer.send({
      subject: getSubject(`${mainSubject}_error`),
      text: errorOutput.join('\n'),
    });
    errorOutput = [];
  }
  const content = contents.map(v => v || '').join('');
  if (!content) return;
  const title = getSubject();
  mailer.send({
    subject: title, text: content,
  });
  serverChan.send(title, content);
}

module.exports = {
  multipleRun,
  serialRun,
  doRun,
  doRun1,
  doCron,
  doCron1,
  TemporarilyOffline,
  sendNotify,
};
