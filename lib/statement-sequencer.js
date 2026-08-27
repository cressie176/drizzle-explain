function createStatementSequencer() {
  const failures = [];
  let tail = Promise.resolve();

  function enqueue(task) {
    const result = tail.then(task);
    tail = result.then(doNothing, (error) => failures.push(error));
    return result;
  }

  async function drain() {
    await tail;
    if (failures.length === 0) return;
    throw failures[0];
  }

  return { enqueue, drain };
}

async function runToCompletion(run, db, sequencer) {
  try {
    await run(db);
  } catch (error) {
    await sequencer.drain().catch(doNothing);
    throw error;
  }
  await sequencer.drain();
}

function doNothing() {}

module.exports = { createStatementSequencer, runToCompletion };
