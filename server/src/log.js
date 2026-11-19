'use strict';

// 结构化日志：单行 JSON，方便 grep 与后续采集
// 级别由 LOG_LEVEL 控制（debug / info / warn / error），默认 info
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const MIN = LEVELS[String(process.env.LOG_LEVEL || 'info').toLowerCase()] || LEVELS.info;

function emit(level, msg, fields) {
  if (LEVELS[level] < MIN) return;
  const line = { ts: new Date().toISOString(), level: level, msg: msg };
  if (fields) Object.assign(line, fields);
  const out = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
  out.write(JSON.stringify(line) + '\n');
}

module.exports = {
  debug: (msg, fields) => emit('debug', msg, fields),
  info: (msg, fields) => emit('info', msg, fields),
  warn: (msg, fields) => emit('warn', msg, fields),
  error: (msg, fields) => emit('error', msg, fields),
};
