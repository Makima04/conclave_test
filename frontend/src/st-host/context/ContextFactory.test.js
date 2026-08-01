import { describe, it, expect, vi } from 'vitest';
import {
  createContextFactory,
  CONTEXT_FIELD_MATRIX,
} from './ContextFactory.js';

function createMessagesState(initial = []) {
  return {
    messages: initial,
    variables: { chat: { a: 1 }, global: { g: true } },
  };
}

describe('CONTEXT_FIELD_MATRIX (P2 progress)', () => {
  it('marks generate/stopGeneration as wireable at P2', () => {
    expect(CONTEXT_FIELD_MATRIX.generate.p2).toBe('wireable');
    expect(CONTEXT_FIELD_MATRIX.stopGeneration.p2).toBe('wireable');
  });

  it('marks generation-path helpers ready at P2', () => {
    expect(CONTEXT_FIELD_MATRIX.updateChatMetadata.p2).toBe('ready');
    expect(CONTEXT_FIELD_MATRIX.getCurrentChatId.p2).toBe('ready');
    expect(CONTEXT_FIELD_MATRIX.deleteLastMessage.p2).toBe('ready');
    expect(CONTEXT_FIELD_MATRIX.chatMetadata.p2).toBe('ready');
    expect(CONTEXT_FIELD_MATRIX.executeSlashCommandsWithOptions.p2).toBe('ready');
    expect(CONTEXT_FIELD_MATRIX.SlashCommandParser.p2).toBe('ready');
  });

  it('keeps large ST objects missing', () => {
    expect(CONTEXT_FIELD_MATRIX.tokenizers.p2).toBe('missing');
    expect(CONTEXT_FIELD_MATRIX.ToolManager.p2).toBe('missing');
    expect(CONTEXT_FIELD_MATRIX.Popup.p2).toBe('missing');
  });
});

describe('createContextFactory P2 fields', () => {
  it('getContext().chat is live and never equals a TavernHelper stand-in', () => {
    const state = createMessagesState([{ message_id: 0, message: 'hi', mes: 'hi' }]);
    const tavernHelper = {
      getChatMessages: () => [],
      setChatMessages: () => {},
      getVariables: () => ({}),
      eventOn: () => {},
      eventEmit: () => {},
    };
    const factory = createContextFactory({
      getRuntimeState: () => state,
      getCardName: () => 'Card',
    });
    const ctx = factory.getContext();
    // KD2: identity and shape — context is not TH and has no TH surface methods.
    expect(ctx).not.toBe(tavernHelper);
    expect(typeof ctx.getChatMessages).toBe('undefined');
    expect(typeof ctx.setChatMessages).toBe('undefined');
    expect(ctx.chat).toBeDefined();
    expect(ctx.eventSource).toBeDefined();
    expect(ctx.chat).toBe(state.messages);
    expect(ctx.chat).toHaveLength(1);
    state.messages.push({ message_id: 1, message: 'next' });
    expect(factory.getContext().chat).toHaveLength(2);
  });

  it('chatMetadata is the same live object across getContext calls and updateChatMetadata merges', () => {
    const factory = createContextFactory({
      getRuntimeState: () => createMessagesState(),
    });
    const a = factory.getContext().chatMetadata;
    const b = factory.getContext().chatMetadata;
    expect(a).toBe(b);
    factory.getContext().updateChatMetadata({ foo: 1 });
    expect(factory.getContext().chatMetadata.foo).toBe(1);
    factory.getContext().updateChatMetadata({ bar: 2 });
    expect(factory.getContext().chatMetadata).toEqual({ foo: 1, bar: 2 });
    factory.getContext().updateChatMetadata({ only: true }, true);
    expect(factory.getContext().chatMetadata).toEqual({ only: true });
  });

  it('addOneMessage writes ST-closer shape (mes/is_user/is_system/send_date)', () => {
    const state = createMessagesState();
    const factory = createContextFactory({ getRuntimeState: () => state });
    factory.getContext().addOneMessage({ mes: 'hello', is_user: true, name: 'User' });
    expect(state.messages).toHaveLength(1);
    const m = state.messages[0];
    expect(m.message).toBe('hello');
    expect(m.mes).toBe('hello');
    expect(m.is_user).toBe(true);
    expect(m.is_system).toBe(false);
    expect(m.role).toBe('user');
    expect(typeof m.send_date).toBe('number');
  });

  it('deleteLastMessage pops chat', () => {
    const state = createMessagesState([
      { message_id: 0, message: 'a' },
      { message_id: 1, message: 'b' },
    ]);
    const factory = createContextFactory({ getRuntimeState: () => state });
    const popped = factory.getContext().deleteLastMessage();
    expect(popped.message).toBe('b');
    expect(state.messages).toHaveLength(1);
  });

  it('generate is wireable via generateFn and tracks isGenerating', async () => {
    const generateFn = vi.fn(async (type) => {
      return `ok:${type}`;
    });
    const factory = createContextFactory({
      getRuntimeState: () => createMessagesState(),
      generateFn,
    });
    const ctx = factory.getContext();
    const result = await ctx.generate('normal');
    expect(result).toBe('ok:normal');
    expect(generateFn).toHaveBeenCalledWith('normal');
    expect(ctx.isGenerating()).toBe(false);
  });

  it('unbound generate rejects with wireable message', async () => {
    const factory = createContextFactory({
      getRuntimeState: () => createMessagesState(),
    });
    await expect(factory.getContext().generate()).rejects.toThrow(/not bound|generateFn/);
  });

  it('stopGeneration invokes inject and clears isGenerating', async () => {
    let resolveGen;
    const generateFn = vi.fn(
      () =>
        new Promise((r) => {
          resolveGen = r;
        })
    );
    const stopGenerationFn = vi.fn();
    const factory = createContextFactory({
      getRuntimeState: () => createMessagesState(),
      generateFn,
      stopGenerationFn,
    });
    const ctx = factory.getContext();
    const pending = ctx.generate();
    // Mid-flight stop
    ctx.stopGeneration();
    expect(stopGenerationFn).toHaveBeenCalled();
    expect(ctx.isGenerating()).toBe(false);
    resolveGen('done');
    await pending;
  });

  it('setGenerateFn rebinds after construction', async () => {
    const factory = createContextFactory({
      getRuntimeState: () => createMessagesState(),
    });
    factory.setGenerateFn(async () => 42);
    await expect(factory.getContext().generate()).resolves.toBe(42);
  });

  it('executeSlashCommandsWithOptions supports /echo and registered commands', async () => {
    const factory = createContextFactory({
      getRuntimeState: () => createMessagesState(),
    });
    const ctx = factory.getContext();
    const echo = await ctx.executeSlashCommandsWithOptions('/echo hello');
    expect(echo).toMatchObject({ pipe: 'hello', isSuccess: true, isError: false });

    ctx.SlashCommandParser.addCommandObject({
      name: 'greet',
      callback: (args) => `hi ${args}`,
    });
    const greet = await ctx.executeSlashCommandsWithOptions('/greet world');
    expect(greet.pipe).toBe('hi world');
  });

  it('executeSlashFn inject overrides built-ins', async () => {
    const executeSlashFn = vi.fn(async () => ({
      pipe: 'custom',
      isError: false,
      isAborted: false,
      isSuccess: true,
      interrupt: false,
    }));
    const factory = createContextFactory({
      getRuntimeState: () => createMessagesState(),
      executeSlashFn,
    });
    const result = await factory.getContext().executeSlashCommandsWithOptions('/echo x');
    expect(result.pipe).toBe('custom');
    expect(executeSlashFn).toHaveBeenCalled();
  });

  it('variables.local/global read live session buckets', () => {
    const state = createMessagesState();
    const factory = createContextFactory({ getRuntimeState: () => state });
    expect(factory.getContext().variables.local).toEqual({ a: 1 });
    expect(factory.getContext().variables.global).toEqual({ g: true });
    state.variables.chat.b = 2;
    expect(factory.getContext().variables.local.b).toBe(2);
  });

  it('characters includes current card name; getCurrentChatId uses inject', () => {
    const factory = createContextFactory({
      getRuntimeState: () => createMessagesState(),
      getCardName: () => 'Hero',
      getChatId: () => 'chat-9',
    });
    const ctx = factory.getContext();
    expect(ctx.characters[0].name).toBe('Hero');
    expect(ctx.name2).toBe('Hero');
    expect(ctx.chatId).toBe('chat-9');
    expect(ctx.getCurrentChatId()).toBe('chat-9');
  });

  it('setExtensionPrompt fills extensionPrompts map', () => {
    const factory = createContextFactory({
      getRuntimeState: () => createMessagesState(),
    });
    const ctx = factory.getContext();
    ctx.setExtensionPrompt('mind.primary', 'remember X', 0, 1, true, 'system');
    expect(ctx.extensionPrompts['mind.primary'].value).toBe('remember X');
    expect(ctx.extensionPrompts['mind.primary'].depth).toBe(1);
  });

  it('isGenerating uses refcount across concurrent generate calls', async () => {
    /** @type {Array<() => void>} */
    const resolvers = [];
    const generateFn = vi.fn(
      () =>
        new Promise((r) => {
          resolvers.push(r);
        })
    );
    const factory = createContextFactory({
      getRuntimeState: () => createMessagesState(),
      generateFn,
    });
    const ctx = factory.getContext();
    const p1 = ctx.generate('a');
    const p2 = ctx.generate('b');
    expect(ctx.isGenerating()).toBe(true);
    resolvers[0]('1');
    await p1;
    // Second still in flight
    expect(ctx.isGenerating()).toBe(true);
    resolvers[1]('2');
    await p2;
    expect(ctx.isGenerating()).toBe(false);
  });

  it('unknown slash command returns isError (not silent success)', async () => {
    const factory = createContextFactory({
      getRuntimeState: () => createMessagesState(),
    });
    const result = await factory
      .getContext()
      .executeSlashCommandsWithOptions('/no-such-command xyz');
    expect(result.isError).toBe(true);
    expect(result.isSuccess).toBe(false);
    expect(result.error).toMatch(/unknown slash command/);
  });
});
