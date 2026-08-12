import { resolveConfig } from "./config.js";
import { startProduction } from "./runtime.js";

async function main(): Promise<void> {
  const config = resolveConfig(process.env);
  const running = await startProduction(config);
  process.stdout.write(
    `taskdrop production listening on ${running.host}:${running.port}\n`,
  );

  const stop = (): void => {
    void running.shutdown().then(
      () => process.exit(0),
      (err) => {
        process.stderr.write(`shutdown error: ${String(err)}\n`);
        process.exit(1);
      },
    );
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

main().catch((err) => {
  process.stderr.write(`startup failed: ${String(err)}\n`);
  process.exit(1);
});
