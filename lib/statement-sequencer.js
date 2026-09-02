function createStatementSequencer() {
  const unobservable = [];
  let callbackHasReturned = false;
  let tail = Promise.resolve();

  function enqueue(task) {
    const result = tail.then(task);
    tail = result.then(doNothing, keepIfUnobservable);
    return result;
  }

  function keepIfUnobservable(error) {
    if (!callbackHasReturned) return;
    unobservable.push(error);
  }

  function stopObserving() {
    callbackHasReturned = true;
  }

  async function drain() {
    await tail;
    if (unobservable.length === 0) return;
    throw unobservable[0];
  }

  return { enqueue, stopObserving, drain };
}

async function runToCompletion(run, db, sequencer) {
  try {
    await runCallback(run, db, sequencer);
  } catch (error) {
    await sequencer.drain().catch(doNothing);
    throw error;
  }
  await sequencer.drain();
}

async function runCallback(run, db, sequencer) {
  try {
    await run(db);
  } finally {
    sequencer.stopObserving();
  }
}

function doNothing() {}

module.exports = { createStatementSequencer, runToCompletion };
