import { expect, test } from "bun:test";
import { route } from "../commands/route";

for (const sub of ["backfill", "mentions"]) {
  test(`${sub} without its required argument exits non-zero`, () => {
    // Bypass index.ts's credential lookup; an empty token prevents Discord calls.
    const result = Bun.spawnSync([
      process.execPath, "-e",
      'import { route } from "./commands/route.ts"; await route(console.log, "", ["route", process.argv[1]]);',
      sub,
    ], { cwd: new URL("..", import.meta.url).pathname });
    expect(result.exitCode).toBe(1);
    expect(result.stdout.toString()).toContain(`usage: maw atlas route ${sub}`);
    expect(result.stderr.toString()).toContain("required");
  });

  test(`${sub} with a channel ID still reaches the token check`, async () => {
    const output: string[] = [];
    await route(line => output.push(line), "", ["route", sub, "123456789012345678"]);
    expect(output).toHaveLength(1);
    expect(output[0]).toContain("no DISCORD_BOT_TOKEN");
  });

  test(`${sub} with an invalid supplied argument keeps its usage behavior`, async () => {
    const output: string[] = [];
    await route(line => output.push(line), "", ["route", sub, "invalid"]);
    expect(output).toHaveLength(1);
    expect(output[0]).toContain(`usage: maw atlas route ${sub}`);
  });
}

test("backfill all still reaches the token check", async () => {
  const output: string[] = [];
  await route(line => output.push(line), "", ["route", "backfill", "all"]);
  expect(output).toHaveLength(1);
  expect(output[0]).toContain("no DISCORD_BOT_TOKEN");
});

for (const args of [["route"], ["route", "help"], ["route", "-h"], ["route", "--help"]]) {
  test(`${args.join(" ")} remains successful help`, async () => {
    const output: string[] = [];
    await route(line => output.push(line), "", args);
    expect(output[0]).toBe("usage:");
  });
}
