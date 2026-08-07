import fs from "node:fs";
import { useCallback, useMemo, useState } from "react";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { lastUsed, listEnvs } from "../env.ts";
import { exportLines } from "../shell.ts";
import { relTime } from "../render.ts";
import { mount } from "./mount.ts";
import { pickLayout, scrollWindow } from "./layout.ts";
import { TooSmall } from "./TooSmall.tsx";
import { BG, BORDER, FG } from "./theme.ts";
import { EnvBrowser } from "./show.tsx";

interface Props {
  emit: string | null;
  exit: (code?: number) => void;
}

function Ls({ emit, exit }: Props) {
  const { width, height } = useTerminalDimensions();
  const names = useMemo(() => listEnvs(), []);
  const used = useMemo(() => lastUsed(), []);
  const [cursor, setCursor] = useState(0);
  const [detail, setDetail] = useState<string | null>(null);

  const active = process.env.TREAD_ENV ?? null;
  const layout = pickLayout(width, height);
  const current = names[cursor] ?? null;

  const activate = useCallback(
    (name: string) => {
      if (emit) {
        try {
          fs.writeFileSync(emit, exportLines(name));
        } catch {}
      }
      exit(0);
    },
    [emit, exit],
  );

  useKeyboard(
    useCallback(
      (key) => {
        if (detail) return; // the browser owns the keyboard while open
        switch (key.name) {
          case "up":
          case "k":
            setCursor((c) => Math.max(0, c - 1));
            break;
          case "down":
          case "j":
            setCursor((c) => Math.min(names.length - 1, c + 1));
            break;
          case "return":
            if (current) activate(current);
            break;
          case "space":
            if (current) setDetail(current);
            break;
          case "q":
          case "escape":
            exit(0);
            break;
        }
      },
      [names.length, current, activate, exit, detail],
    ),
  );

  const rows = useMemo(() => {
    const nameWidth = Math.max(4, ...names.map((n) => n.length));
    const win = scrollWindow(cursor, names.length, Math.max(1, height - 4));
    return names.slice(win.start, win.end).map((n, i) => ({
      name: n,
      index: win.start + i,
      padded: n.padEnd(nameWidth),
      when: relTime(used[n] ?? null),
    }));
  }, [names, used, cursor, height]);

  if (layout.mode === "plain") return <TooSmall width={width} height={height} />;

  if (detail) {
    return (
      <EnvBrowser
        name={detail}
        onBack={() => setDetail(null)}
        onQuit={() => exit(0)}
        width={width}
        height={height}
      />
    );
  }

  const footer =
    layout.mode === "minimal"
      ? " ↑↓  ⏎  ␣  q "
      : " ↑↓ move   ⏎ activate   ␣ detail   q quit ";

  return (
    <box
      flexDirection="column"
      border
      borderStyle="rounded"
      borderColor={BORDER}
      title=" tread "
      bottomTitle={footer}
      padding={1}
    >
      {names.length === 0 ? (
        <text fg={FG.dim}>no environments — tread create &lt;name&gt;</text>
      ) : (
        rows.map((r) => {
          const sel = r.index === cursor;
          const isActive = r.name === active;
          return (
            <box key={r.name} flexDirection="row" backgroundColor={sel ? BG.select : undefined}>
              <text fg={sel ? FG.onSelect : isActive ? FG.active : FG.dim}>
                {isActive ? " ● " : "   "}
              </text>
              <text fg={sel ? FG.onSelect : FG.normal}>{r.padded}</text>
              <text fg={sel ? FG.onSelect : FG.dim}>{`    ${r.when}`}</text>
            </box>
          );
        })
      )}
    </box>
  );
}

export async function mountLs(opts: { emit: string | null }): Promise<number> {
  return await mount((exit) => <Ls emit={opts.emit} exit={exit} />);
}
