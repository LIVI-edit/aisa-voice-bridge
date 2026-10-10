import { runCli, formatCliError } from './cli.js';
import { loadConfig } from './config.js';

try { await import('dotenv/config'); } catch (error) { if (error?.code !== 'ERR_MODULE_NOT_FOUND') throw error; }
let config;
try {
  config = loadConfig(process.env);
  const signalRegistrar = (handler) => {
    const onInt=()=>handler('SIGINT'), onTerm=()=>handler('SIGTERM');
    process.once('SIGINT',onInt); process.once('SIGTERM',onTerm);
    return ()=>{process.off('SIGINT',onInt);process.off('SIGTERM',onTerm)};
  };
  const code = await runCli(process.argv.slice(2), { env: process.env, signalRegistrar });
  process.exitCode = code;
} catch (error) {
  console.error(formatCliError(error, config));
  process.exitCode = 1;
}
