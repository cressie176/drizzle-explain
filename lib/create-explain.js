const { explain } = require('./explain');

function createExplain(driver, defaults = {}) {
  return (run, overrides = {}) => explain(driver, defaults, run, overrides);
}

module.exports = { createExplain };
