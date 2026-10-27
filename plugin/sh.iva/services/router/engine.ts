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
  /** Prepare and deliver a plugin-owned action here in chat. Never confirms it. */
  issue(id: string, page: string, owner: number): Promise<{ state: string }> {
    const operation = this.tail.then(async () => {
      const state = await this.store.load();
      const previous = state.screens[id];
      if (previous) {
        if (
          previous.owner !== owner ||
          previous.closed ||
          previous.expires < this.now()
        )
          throw new Error("CARD_UNAVAILABLE");
        return {
          state:
            previous.message === null
              ? "delivery_unknown"
              : "already_presented",
        };
      }
      if (Object.keys(state.screens).length >= LIMITS.screens)
        throw new Error("SCREEN_CAPACITY");
      // Intent precedes provider prepare and send. An unknown send is never replayed.
      state.screens[id] = {
        owner,
        chat: owner,
        message: null,
        revision: 0,
        expires: this.now() + TTL,
        page,
        view: { title: "Подготовка", body: "", rows: [] },
        closed: false,
      };
      await this.store.save(state);
      const view = viewSchema.parse(await this.provider.page(page));
      const payload = render(view, id, 0);
      state.screens[id].view = view;
      await this.store.save(state);
      try {
        const message = await this.delivery.send(owner, payload);
        if (!Number.isSafeInteger(message) || message <= 0)
          throw new Error("UNKNOWN_SEND");
        state.screens[id].message = message;
        await this.store.save(state);
        return { state: "presented" };
      } catch {
        return { state: "delivery_unknown" };
      }
    });
    this.tail = operation.catch(() => {});
    return operation;
  }
  handle(event: Event, part?: number): Promise<void> {
    const operation = this.tail.then(() => this.perform(event, part));
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
  private async perform(event: Event, part?: number) {
    const state = await this.store.load();
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
    const key =
      part === undefined
        ? String(event.update_id)
        : `${event.update_id}:${part}:${hash}`;
    // Bridge may regroup an inbox after a failed acknowledgement. Message identity
    // survives that regrouping even when the batch's maximum update ID changes.
    const previousKey = state.events[key]
      ? key
      : Object.keys(state.events).find((k) => state.events[k].hash === hash);
    const prior =
      previousKey === undefined ? undefined : state.events[previousKey];
    if (prior) {
      if (prior.hash !== hash) throw new Error("EVENT_COLLISION");
      if (prior.phase === "acting") {
        const screen = state.screens[prior.screen];
        if (!screen || !this.provider.recover)
          throw new Error("ACTION_RECOVERY_REQUIRED");
        screen.view = viewSchema.parse(
          await this.provider.recover(screen.page),
        );
        screen.revision++;
        prior.phase = "editing";
        await this.store.save(state);
        await this.deliver(state, previousKey!);
      } else if (prior.phase === "editing")
        await this.deliver(state, previousKey!);
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
          (e) => e.screen === id && ["editing", "acting"].includes(e.phase),
        )
      )
        delete state.screens[id];
    }
    if (Object.keys(state.events).length >= LIMITS.events) {
      const done = Object.keys(state.events)
        .filter((k) => ["done", "uncertain"].includes(state.events[k].phase))
        .sort((a, b) => Number.parseInt(a, 10) - Number.parseInt(b, 10))[0];
      if (!done) throw new Error("EVENT_CAPACITY");
      state.floor = Math.max(state.floor, Number.parseInt(done, 10));
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
        (e) =>
          e.screen === action.screen && ["editing", "acting"].includes(e.phase),
      )
    )
      return;
    const button = screen.view.rows.flat()[action.index];
    if (!button) return;
    const close = button.id === "close";
    const mutation = this.provider.isMutation?.(button.id) ?? false;
    if (mutation) {
      screen.page = button.id;
      state.events[key] = { hash, screen: action.screen, phase: "acting" };
      await this.store.save(state);
    }
    let selected;
    if (!close) {
      try {
        selected = await this.provider.page(button.id);
      } catch (error) {
        if (!mutation || !this.provider.recover) throw error;
        selected = await this.provider.recover(button.id);
      }
    }
    const view = close
      ? {
          title: "Панель закрыта",
          body: "Чтобы открыть снова, отправьте /panels.",
          rows: [],
        }
      : viewSchema.parse(selected);
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
