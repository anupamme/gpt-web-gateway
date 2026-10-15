const { AsyncLocalStorage } = require('node:async_hooks');

// Share the installation even if this module is loaded again. Outside a job,
// forward the original arguments unchanged (including console format strings).
const key = Symbol.for('gpt-web-gateway.log-context');
if (!console[key]) {
  const storage = new AsyncLocalStorage();
  Object.defineProperty(console, key, { value: storage });
  for (const method of ['log', 'warn', 'error']) {
    const original = console[method].bind(console);
    console[method] = (...args) => {
      const context = storage.getStore();
      if (context && Number.isInteger(context.slotId)) {
        const prefix = `[s${context.slotId}]`;
        if (typeof args[0] === 'string') args[0] = `${prefix} ${args[0]}`;
        else args.unshift(prefix);
      }
      return original(...args);
    };
  }
}

function runWithLogContext(context, fn) {
  return console[key].run(context, fn);
}

module.exports = { runWithLogContext };
