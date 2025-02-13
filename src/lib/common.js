const _ = require('lodash');
const fs = require('fs');
const path = require('path');
const rp = require('request-promise');
const download = require('download');
const {getNowHour, getNowTime, getNowDate} = require('./moment');

const _sleep = require('util').promisify(setTimeout);
/**
 *
 * @param seconds {number}
 */
const sleep = (seconds = 1) => _sleep(seconds * 1000);

const logPath = path.resolve(__dirname, '../../logs');
const getLogFile = (fileName, date = getNowDate()) => `${logPath}/${fileName}.log.${date}`;
const printLog = (scriptName = '', fileName = 'app', output, type = 'info') => {
  const logFile = fs.createWriteStream(path.extname(fileName) ? fileName : getLogFile(fileName), {flags: 'a'});
  const _log = chunk => {
    _.isPlainObject(chunk) && (chunk = JSON.stringify(chunk));
    logFile.write(`${getNowTime()} [${scriptName}] [${type}] ${chunk}\n`);
  };
  [].concat(output).forEach(_log);
};
const cleanLog = (fileName) => {
  fs.writeFileSync(getLogFile(fileName), '');
};

const _getAbsolutePath = (fileName, dirname) => dirname ? path.resolve(dirname, fileName) : fileName;
// 将json写入文件中
const writeFileJSON = (data, fileName, dirname) => fs.writeFileSync(_getAbsolutePath(fileName, dirname), JSON.stringify(data), {encoding: 'utf-8'});
const readFileJSON = (fileName, dirname, defaultValue = {}) => {
  const absolutePath = _getAbsolutePath(fileName, dirname);
  if (!fs.existsSync(absolutePath)) return defaultValue;
  const data = fs.readFileSync(absolutePath).toString();
  if (!data) return defaultValue;
  let result;
  try {
    result = JSON.parse(data);
  } catch (e) {
    console.log(e);
  }
  result = result || defaultValue;
  return result;
};

async function parallelRun({list, runFn, onceNumber = list.length, onceDelaySecond = 0}) {
  return Promise.all(list.map((item, index) => new Promise(async resolve => {
    const delaySecond = Math.floor(index / onceNumber) * onceDelaySecond;
    delaySecond && await sleep(delaySecond);
    const result = await runFn(item);
    resolve(result);
  })));
}

/**
 * @description 获取重定向链接(短链接)的真正URL
 * @param uri{string}
 * @param after200Fn{function}
 * @param options{object}
 * @return {Promise<string>}
 */
async function getRealUrl(uri, after200Fn, options = {}) {
  _.assign(options, {
    uri, followRedirect: false,
    resolveWithFullResponse: true,
  });
  if (new URL(uri).host === 'u.jd.com') {
    after200Fn = body => {
      const urlPrefix = 'var hrl=\'';
      const prefixMatch = body.match(urlPrefix);
      if (!prefixMatch) return;
      return body.substring(prefixMatch.index + urlPrefix.length, body.match('\';var ua=').index);
    };
  }
  return rp(options).then(res => {
    if (res.statusCode === 200) {
      const body = res.body;
      if (!after200Fn) {
        console.log(`${uri} 不需要302`);
        return uri;
      }
      const newUri = after200Fn(body);
      if (!newUri) return console.log(`${uri}, 获取出错`);
      return getRealUrl(newUri, after200Fn, options);
    }
  }).catch(function (error) {
    const res = error.response;
    if (res.statusCode === 302) {
      const realUrl = _.property('headers.location')(res);
      console.log('真正的URL地址如下:');
      console.log(realUrl);
      return realUrl;
    }
    console.log(`${uri}, 获取出错`);
  });
}

function getOriginDataFromFile(filePath) {
  return fs.existsSync(filePath) ? _.filter(fs.readFileSync(filePath).toString().split(/\r?\n/g)) : [];
}

function getUrlDataFromFile(filePath) {
  return _.filter(getOriginDataFromFile(filePath), str => str.startsWith('http'));
}

/**
 * @description 字符串化Object的值
 * @param target {Object}
 */
function objectValuesStringify(target) {
  if (_.isEmpty(target)) return;
  for (const [key, value] of Object.entries(target)) {
    if (!_.isString(value)) {
      try {
        target[key] = JSON.stringify(value);
      } catch (e) {
      }
    }
  }
}

/**
 * @description 根据正则匹配居于中间的数据
 * @param target {string}
 * @param reg {RegExp|undefined} 正则表达式, eg: /"test":"(\w*)"/
 * @param prefix {string|undefined} 匹配的开始
 * @param suffix {string|undefined} 匹配的结尾
 * @param match {string|undefined} 需要找出的内容
 * @return {string}
 */
function matchMiddle(target, {reg, prefix, suffix, match = '\w'}) {
  reg = reg || new RegExp(`${prefix}(${match}*)${suffix}`);
  const execResult = reg.exec(target) || [];
  return execResult[1] || '';
}

/**
 * @description 单个文件运行脚本
 * @param target {Class}
 * @param method {String|Array|undefined}
 * @param runFn {Function|undefined}
 * @return {Promise|*}
 */
async function singleRun(target, method = 'start', runFn = null) {
  const {updateProcessEnv, getCookieData} = require('./env');
  const [nodePath, filePath, command1] = process.argv;
  const fileName = path.basename(filePath);
  let scriptName1 = fileName.replace(/\.js$/, '');
  const fileParentDirName = path.basename(path.dirname(filePath));
  // 必须是当前执行的文件, 避免被继承的类被执行
  const scriptName = target.scriptName;
  let envCookieName;
  if ([
    'Earn',
    'EarnAdvertPlugin',
  ].includes(scriptName)) {
    // TODO 更改 getCookieData
    envCookieName = 'JD_EARN_COOKIE';
  }
  const isCurrentFile = eq(scriptName, scriptName1) || eq(scriptName, `${fileParentDirName}${scriptName1 === 'index' ? '' : scriptName1}`);

  let promise;

  for (const m of _.concat(method)) {
    if (command1 === m && isCurrentFile) {
      updateProcessEnv();
      promise = await (runFn ? runFn(m, getCookieData) : target[m](getCookieData(void 0, envCookieName)));
    }
  }

  return promise;

  function eq(value, other) {
    return _.eq(..._.map([value, other], _.toLower));
  }
}

function replaceObjectMethod(context, method, patchArgsFn) {
  const target = context[method];
  context[method] = async (...args) => target.apply(context, await patchArgsFn(args));
}

/**
 * @description 从Function获取其他类型获取值
 * @param target {Function|*}
 * @param option {Object}
 * @return {*}
 */
function getValueByFn(target, option = {}) {
  const {context} = option;
  return _.isFunction(target) ? target.call(context) : target;
}

/**
 * @description 下载文件
 * @param urls {Array}
 * @param dirname __dirname
 */
function downloadFile(urls, dirname) {
  urls.forEach(async url => {
    await download(url, dirname);
  });
}

module.exports = {
  sleep,

  getLogFile,
  printLog,
  cleanLog,

  writeFileJSON,
  readFileJSON,

  parallelRun,

  getRealUrl,
  getUrlDataFromFile,
  getOriginDataFromFile,

  objectValuesStringify,
  matchMiddle,

  singleRun,

  replaceObjectMethod,

  getValueByFn,

  downloadFile,
};
