import { loadConfig, validateNumber, safeMessage } from './config.js';
import { CallSession } from './call-session.js';

let config;
let session;
try {
  if (process.argv.length !== 3) throw new Error('Запуск: node src/index.js +380XXXXXXXXX');
  const number = validateNumber(process.argv[2]);
  config = loadConfig();
  session = new CallSession(config, number);
  const stop = () => { void session.cleanup('Остановка по сигналу'); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  try {
    const result = await session.run();
    if (result.failed) process.exitCode = 1;
  } finally {
    process.off('SIGINT', stop); process.off('SIGTERM', stop);
  }
} catch (error) {
  console.error(safeMessage(error, config));
  process.exitCode = 1;
  if (session) await session.cleanup('Завершение после ошибки');
}
