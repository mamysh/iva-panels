import { createHash, randomBytes } from "node:crypto";
import { Store, type State } from "./store.ts";
import {
  LIMITS,
  TTL,
  parseAction,
  render,
  viewSchema,
  type Event,
} from "./contracts.ts";
import type { Provider } from "./providers.ts";
export interface Delivery {
  send(chat: number, payload: ReturnType<typeof render>): Promise<number>;
  edit(
    chat: number,
    message: number,
    payload: ReturnType<typeof render>,
  ): Promise<void>;
}
export class Engine {
  store: Store;
  provider: Provider;
  delivery: Delivery;
  now: () => number;
  private tail: Promise<unknown> = Promise.resolve();
  constructor(
    store: Store,
    provider: Provider,
    delivery: Delivery,
    now = Date.now,
  ) {
    this.store = store;
    this.provider = provider;
    this.delivery = delivery;
    this.now = now;
  }
  handle(event: Event): Promise<void> {
    const operation = this.tail.then(() => this.perform(event));
    this.tail = operation.catch(() => {});
    return operation;
  }
  private async deliver(state: State, key: string): Promise<void> {
    const receipt = state.events[key];
    const screen = state.screens[receipt.screen];
    if (!screen || screen.message === null) throw new Error("MISSING_SCREEN");
    await this.delivery.edit(
      screen.chat,
      screen.message,
      render(screen.view, receipt.screen, screen.revision),
    );
    receipt.phase = "done";
    await this.store.save(state);
  }
  private async perform(event: Event) {
    const state = await this.store.load();
    const key = String(event.update_id);
    const hash = createHash("sha256")
      .update(
        JSON.stringify([
          event.message.from.id,
          event.message.chat.id,
          event.message.message_id,
          event.message.text,
        ]),
      )
      .digest("hex");
    const prior = state.events[key];
    if (prior) {
      if (prior.hash !== hash) throw new Error("EVENT_COLLISION");
      if (prior.phase === "editing") await this.deliver(state, key);
      else if (prior.phase === "sending") {
        prior.phase = "uncertain";
        await this.store.save(state);
      }
      return;
    }
    if (event.update_id <= state.floor) return;
    for (const [id, screen] of Object.entries(state.screens)) {
      if (
        screen.expires < this.now() &&
        !Object.values(state.events).some(
          (e) => e.screen === id && e.phase === "editing",
        )
      )
        delete state.screens[id];
    }
    if (Object.keys(state.events).length >= LIMITS.events) {
      const done = Object.keys(state.events)
        .filter((k) => ["done", "uncertain"].includes(state.events[k].phase))
        .sort((a, b) => Number(a) - Number(b))[0];
      if (!done) throw new Error("EVENT_CAPACITY");
      state.floor = Math.max(state.floor, Number(done));
      delete state.events[done];
      if (event.update_id <= state.floor) {
        await this.store.save(state);
        return;
      }
    }
    if (event.message.text === "/panels") {
      if (Object.keys(state.screens).length >= LIMITS.screens)
        throw new Error("SCREEN_CAPACITY");
      const id = randomBytes(12).toString("hex");
      const view = viewSchema.parse(await this.provider.page("home"));
      const payload = render(view, id, 0);
      state.screens[id] = {
        owner: event.message.from.id,
        chat: event.message.chat.id,
        message: null,
        revision: 0,
        expires: this.now() + TTL,
        page: "home",
        view,
        closed: false,
      };
      state.events[key] = { hash, screen: id, phase: "sending" };
      await this.store.save(state);
      // A send with an unknown outcome is never replayed, including after restart.
      try {
        const message = await this.delivery.send(
          event.message.chat.id,
          payload,
        );
        if (!Number.isSafeInteger(message) || message <= 0)
          throw new Error("BAD_MESSAGE_ID");
        state.screens[id].message = message;
        state.events[key].phase = "done";
      } catch {
        state.events[key].phase = "uncertain";
      }
      await this.store.save(state);
      return;
    }
    const action = parseAction(event.message.text);
    if (!action) return;
    const screen = state.screens[action.screen];
    if (
      !screen ||
      screen.closed ||
      screen.expires < this.now() ||
      screen.owner !== event.message.from.id ||
      screen.chat !== event.message.chat.id ||
      screen.message !== event.message.message_id ||
      screen.revision !== action.revision
    )
      return;
    if (
      Object.values(state.events).some(
        (e) => e.screen === action.screen && e.phase === "editing",
      )
    )
      return;
    const button = screen.view.rows.flat()[action.index];
    if (!button) return;
    const close = button.id === "close";
    const view = close
      ? {
          title: "Панель закрыта",
          body: "Чтобы открыть снова, отправьте /panels.",
          rows: [],
        }
      : viewSchema.parse(await this.provider.page(button.id));
    render(view, action.screen, screen.revision + 1);
    screen.view = view;
    screen.page = button.id;
    screen.revision++;
    screen.closed = close;
    state.events[key] = { hash, screen: action.screen, phase: "editing" };
    await this.store.save(state);
    await this.deliver(state, key);
  }
}
