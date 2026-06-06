import { getMe, listSlashCommands, registerSlashCommands, deleteSlashCommand } from "../lib/discord";

const BUILTIN_COMMANDS: Record<string, any> = {
  thread: {
    name: "thread",
    description: "Create a new thread and start an Atlas session",
    type: 1,
    options: [{
      name: "name",
      description: "Thread name",
      type: 3,
      required: true,
    }],
  },
  status: {
    name: "status",
    description: "Show Atlas Oracle status",
    type: 1,
  },
  whoami: {
    name: "whoami",
    description: "Show bot identity",
    type: 1,
  },
};

export async function slash(log: (s: string) => void, token: string, args: string[]) {
  const sub = args[1];
  const me = await getMe(token);
  const appId = me.id;

  if (!sub || sub === "help") {
    log("usage:");
    log("  maw atlas slash list                  list registered commands");
    log("  maw atlas slash register <name>       register a slash command");
    log("  maw atlas slash register --all        register all built-in commands");
    log("  maw atlas slash remove <name-or-id>   remove a slash command");
    log("");
    log("built-in commands: " + Object.keys(BUILTIN_COMMANDS).join(", "));
    return;
  }

  if (sub === "list") {
    const cmds = await listSlashCommands(token, appId);
    if (!Array.isArray(cmds) || cmds.length === 0) {
      log("no slash commands registered");
      return;
    }
    const json = args.includes("--json");
    if (json) {
      log(JSON.stringify(cmds, null, 2));
    } else {
      for (const c of cmds) {
        const opts = c.options?.map((o: any) => `<${o.name}>`).join(" ") || "";
        log(`  /${c.name} ${opts} — ${c.description} (${c.id})`);
      }
      log(`\n${cmds.length} commands`);
    }
    return;
  }

  if (sub === "register") {
    const name = args[2];
    if (name === "--all") {
      const all = Object.values(BUILTIN_COMMANDS);
      const result = await registerSlashCommands(token, appId, all);
      log(`✓ registered ${Array.isArray(result) ? result.length : 0} commands`);
      if (Array.isArray(result)) {
        for (const c of result) log(`  /${c.name} (${c.id})`);
      }
      return;
    }
    if (!name) { log("usage: maw atlas slash register <name|--all>"); return; }
    const cmd = BUILTIN_COMMANDS[name.replace(/^\//, "")];
    if (!cmd) {
      log(`✗ unknown command: ${name}`);
      log("available: " + Object.keys(BUILTIN_COMMANDS).join(", "));
      return;
    }
    const existing = await listSlashCommands(token, appId);
    const merged = Array.isArray(existing) ? existing.map((e: any) => {
      if (e.name === cmd.name) return cmd;
      return { name: e.name, description: e.description, type: e.type, options: e.options };
    }) : [];
    if (!merged.find((c: any) => c.name === cmd.name)) merged.push(cmd);
    const result = await registerSlashCommands(token, appId, merged);
    const registered = Array.isArray(result) ? result.find((c: any) => c.name === cmd.name) : null;
    if (registered) {
      log(`✓ /${registered.name} registered (${registered.id})`);
    } else {
      log(`✓ registered (${Array.isArray(result) ? result.length : 0} total commands)`);
    }
    return;
  }

  if (sub === "remove") {
    const target = args[2];
    if (!target) { log("usage: maw atlas slash remove <name-or-id>"); return; }
    const cmds = await listSlashCommands(token, appId);
    if (!Array.isArray(cmds)) { log("✗ could not list commands"); return; }
    const match = cmds.find((c: any) => c.name === target.replace(/^\//, "") || c.id === target);
    if (!match) { log(`✗ command not found: ${target}`); return; }
    await deleteSlashCommand(token, appId, match.id);
    log(`✓ /${match.name} removed (${match.id})`);
    return;
  }

  log(`unknown: ${sub} — run 'maw atlas slash help'`);
}
