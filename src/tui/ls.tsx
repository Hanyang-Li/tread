import fs from "node:fs";
import { useCallback, useMemo, useState } from "react";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { createEnv, lastUsed, listEnvs, removeEnv } from "../env.ts";
import { exportLines } from "../shell.ts";
import { relTime } from "../render.ts";
import { mount } from "./mount.ts";
import { pickLayout, scrollWindow } from "./layout.ts";
import { TooSmall } from "./TooSmall.tsx";
import { BG, BORDER, FG } from "./theme.ts";
import { EnvBrowser } from "./show.tsx";

type Mode = "list" | "create" | "confirm";

interface Props {
  emit: string | null;
  exit: (code?: number) => void;
}

function Ls({ emit, exit }: Props) {
  const { width, height } = useTerminalDimensions();
  const [names, setNames] = useState(() => listEnvs());
  const [used, setUsed] = useState(() => lastUsed());
  const [cursor, setCursor] = useState(0);
  const [mode, setMode] = useState<Mode>("list");
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [showing, setShowing] = useState<string | null>(null);

  const active = process.env.TREAD_ENV ?? null;
  const layout = pickLayout(width, height);
  const current = names[cursor] ?? null;

  const refresh = useCallback(() => {
    const n = listEnvs();
    setNames(n);
    setUsed(lastUsed());
    setCursor((c) => Math.max(0, Math.min(c, n.length - 1)));
  }, []);

  const submitDraft = useCallback(() => {
    try {
      createEnv(draft.trim());
      refresh();
      setMode("list");
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message.split("\n")[0] : String(e));
    }
  }, [draft, refresh]);

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
        if (showing) return; // the browser owns the keyboard while open

        if (mode === "create") {
          if (key.name === "escape") {
            setMode("list");
            setError(null);
          }
          return;
        }

        if (mode === "confirm") {
          if (key.name === "y" && current) {
            try {
              removeEnv(current);
              refresh();
            } catch (e) {
              setError(e instanceof Error ? e.message.split("\n")[0] : String(e));
            }
          }
          setMode("list");
          return;
        }

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
          case "s":
            if (current) setShowing(current);
            break;
          case "c":
            setDraft("");
            setError(null);
            setMode("create");
            break;
          case "r":
            if (current) {
              if (current === active) setError(`"${current}" is currently active`);
              else setMode("confirm");
            }
            break;
          case "q":
          case "escape":
            exit(0);
            break;
        }
      },
      [mode, names.length, current, active, activate, exit, refresh, showing],
    ),
  );

  const rows = useMemo(() => {
    const nameWidth = Math.max(4, ...names.map((n) => n.length));
    const win = scrollWindow(cursor, names.length, Math.max(1, height - 6));
    return names.slice(win.start, win.end).map((n, i) => ({
      name: n,
      index: win.start + i,
      padded: n.padEnd(nameWidth),
      when: relTime(used[n] ?? null),
    }));
  }, [names, used, cursor, height]);

  if (layout.mode === "plain") return <TooSmall width={width} height={height} />;

  if (showing) {
    return (
      <EnvBrowser
        name={showing}
        onBack={() => setShowing(null)}
        onQuit={() => exit(0)}
        width={width}
        height={height}
      />
    );
  }

  const footer =
    layout.mode === "minimal"
      ? " ↑↓  ⏎  s  c  r  q "
      : layout.mode === "narrow"
        ? " ↑↓  ⏎ activate  s show  c create  r remove  q "
        : " ↑↓ move   ⏎ activate   s show   c create   r remove   q quit ";

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
        <text fg={FG.dim}>no environments — press c to create one</text>
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

      {mode === "create" ? (
        <box flexDirection="row" marginTop={1}>
          <text fg={FG.dim}>name: </text>
          <input focused value={draft} onInput={setDraft} onSubmit={submitDraft} />
        </box>
      ) : null}

      {mode === "confirm" ? (
        <text fg={FG.warn} marginTop={1}>{`remove "${current}"? this cannot be undone  [y/N]`}</text>
      ) : null}

      {error ? (
        <text fg={FG.error} marginTop={1}>
          {error}
        </text>
      ) : null}
    </box>
  );
}

export async function mountLs(opts: { emit: string | null }): Promise<number> {
  return await mount((exit) => <Ls emit={opts.emit} exit={exit} />);
}
