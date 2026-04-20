// Run only the session-level aggregation phase. Useful when the sync
// container is stuck chewing through a big message backlog and we need
// fresh summaries on recently-reset sessions without waiting days.

import { updateAggregateEmbeddings } from "../src/embeddings/batch.js";
import { closePool } from "../src/db/postgres.js";

const main = async () => {
  let total = 0;
  while (true) {
    const stats = await updateAggregateEmbeddings();
    if (stats.sessionsUpdated === 0 && stats.sessionsReembedded === 0) {
      console.log(`done. total sessions processed: ${total}`);
      return;
    }
    total += stats.sessionsUpdated + stats.sessionsReembedded;
    console.log(`cycle: +${stats.sessionsUpdated} new, +${stats.sessionsReembedded} reembedded (running total ${total})`);
  }
};

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => closePool());
