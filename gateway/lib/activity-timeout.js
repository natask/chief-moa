"use strict";

function withActivityTimeout(start, timeoutMs, label) {
  const duration = Number(timeoutMs);
  if (!(duration > 0)) {
    return Promise.resolve().then(() => start(() => {}));
  }
  return new Promise((resolve, reject) => {
    let timer = null;
    let settled = false;
    const clear = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    };
    const fail = () => {
      if (settled) return;
      settled = true;
      timer = null;
      reject(new Error(`${label || "operation"} inactivity timeout after ${duration}ms`));
    };
    const touch = () => {
      if (settled) return;
      clear();
      timer = setTimeout(fail, duration);
    };
    touch();
    Promise.resolve()
      .then(() => start(touch))
      .then((value) => {
        if (settled) return;
        settled = true;
        clear();
        resolve(value);
      }, (error) => {
        if (settled) return;
        settled = true;
        clear();
        reject(error);
      });
  });
}

module.exports = { withActivityTimeout };
