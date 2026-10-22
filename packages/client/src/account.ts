/**
 * account.ts — the account screen (docs/RATING_PLAN.md): create an account,
 * log in, and once logged in the handle, rating and record, with Rename,
 * Replace key, Log out and Delete account. Opened from the lobby, or with
 * `?account`; its own chunk, fetched when first opened.
 *
 * The key is the account, and the server picks it, so the screen's real job
 * is getting the key into the player's password manager. Managers save what's
 * submitted in a login-shaped form and fill it back on the same site, so the
 * key is shown in real forms: a handle in an `autocomplete="username"` field
 * and the key in a password field (`new-password` when issued,
 * `current-password` to log in or delete). Submitting a form, then the form
 * going away, is what makes a manager offer to save. Copy, Download and Show
 * cover players without one. A browser may offer to generate a password for a
 * `new-password` field; if the player takes it, the field no longer holds the
 * key, so the form puts the key back and asks again rather than let the
 * manager save the wrong thing.
 */

import { normalizeHandle, type AccountInfo } from '@crack-attack/protocol';
import { AccountClient, AccountError, apiOriginFor } from './account/accountApi.js';
import { AccountState, browserStorage } from './account/accountState.js';
import { BitmapLabel } from './render/bitmapText.js';
import { FONT0 } from './view/bitmapFont.js';
import { ratingText, recordText } from './view/rating.js';

export interface AccountScreenNav {
  back(): void;
  leaderboard(): void;
}

/** Show the screen for the relay at `relayUrl`. */
export function bootAccount(relayUrl: string, nav: AccountScreenNav): { dispose(): void } {
  const origin = apiOriginFor(relayUrl);
  const client = origin === null ? null : new AccountClient(origin);
  const state = new AccountState(browserStorage());
  let disposed = false;

  const root = document.createElement('div');
  root.style.cssText =
    'position:fixed;inset:0;z-index:10;overflow:auto;background:#0b0d12;color:#d7dce5;' +
    'font-family:system-ui,sans-serif;font-size:14px';
  const column = document.createElement('div');
  column.style.cssText =
    'max-width:440px;margin:0 auto;padding:64px 16px 48px;display:flex;flex-direction:column;gap:14px';
  root.append(column);

  const header = document.createElement('div');
  header.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:12px';
  const title = new BitmapLabel(FONT0, { height: 26, color: '#e7ebf3' });
  title.setText('ACCOUNT');
  title.element.setAttribute('role', 'heading');
  title.element.setAttribute('aria-label', 'Account');
  header.append(
    title.element,
    button('Back', () => leave()),
  );

  const status = document.createElement('div');
  status.setAttribute('role', 'status');
  status.style.cssText = 'min-height:18px;opacity:.85';
  const body = document.createElement('div');
  body.style.cssText = 'display:flex;flex-direction:column;gap:14px';
  column.append(header, status, body);
  document.body.append(root);

  const say = (text: string): void => {
    status.textContent = text;
  };
  /**
   * What leaving (Back, Esc) must not lose: a registration in flight (it may
   * already be logged in, its key not yet shown), or a key on screen that the
   * player hasn't said is saved. The key can't be shown again.
   */
  let guard: 'busy' | 'key' | null = null;
  let leaveArmed = false;
  const leave = (): void => {
    if (guard === 'busy') return;
    if (guard === 'key' && !leaveArmed) {
      leaveArmed = true;
      say("Your key can't be shown again once you leave. Press Back again to leave anyway.");
      return;
    }
    nav.back();
  };
  /** A failed request, in the player's words. */
  const failed = (err: unknown): string => {
    if (!(err instanceof AccountError)) return 'Something went wrong.';
    switch (err.code) {
      case 'network':
        return "Can't reach the server right now.";
      case 'rate_limited':
        return 'Too many tries — wait a little and try again.';
      case 'bad_key':
        return err.message === "that key is another account's"
          ? "That's another account's key."
          : "That key doesn't match any account.";
      case 'handle_taken':
        return 'That handle is taken.';
      case 'bad_handle':
        return 'A handle needs at least one visible character.';
      default:
        return err.message;
    }
  };
  const show = (...nodes: Node[]): void => {
    if (!disposed) body.replaceChildren(...nodes);
  };

  // --- logged out -----------------------------------------------------------------

  function showLoggedOut(): void {
    const intro = paragraph(
      'An account keeps a rating and lets you play rated games. There is no email or ' +
        'password: the server gives you a key of eight words, and the key is the account. ' +
        'Lose it and the account is gone, so keep it in your password manager.',
    );

    const create = section('Create an account');
    const handleInput = input('text', 'handle', 'Handle');
    handleInput.maxLength = 32;
    handleInput.autocomplete = 'off';
    const createBtn = button('Create account', () => void register());
    create.append(labeled('Handle', handleInput), createBtn);
    const register = async (): Promise<void> => {
      if (!client) return;
      const handle = normalizeHandle(handleInput.value);
      if (handle === null) {
        say('A handle needs at least one visible character (at most 16).');
        return;
      }
      createBtn.disabled = true;
      say('Creating…');
      guard = 'busy';
      try {
        const res = await client.register(handle, state.guestTokenForRegistration());
        state.registered(res.session, res.account.handle);
        say('');
        showSaveKey(res.account.handle, res.key, true, () => showAccount(res.account));
      } catch (err) {
        guard = null;
        say(failed(err));
        createBtn.disabled = false;
      }
    };

    const login = section('Log in');
    const form = keyForm('login', '', 'current-password', 'Log in');
    login.append(
      paragraph('Your password manager can fill this in. The handle is only a label.'),
      form.form,
    );
    form.form.onsubmit = (e): void => {
      e.preventDefault();
      void (async () => {
        if (!client) return;
        form.submit.disabled = true;
        say('Logging in…');
        try {
          const res = await client.login(form.key.value);
          state.loggedIn(res.session, res.account.handle);
          say(`Logged in as ${res.account.handle}.`);
          // The form goes away on success: what a password manager watches for.
          showAccount(res.account);
        } catch (err) {
          say(failed(err));
          form.submit.disabled = false;
        }
      })();
    };

    show(intro, create, login);
    handleInput.focus();
  }

  // --- the key ----------------------------------------------------------------------

  /**
   * Show a freshly issued key in a form built to be saved by a password
   * manager, with Copy, Download and Show beside it. `then` continues once the
   * player has saved it.
   */
  function showSaveKey(handle: string, key: string, isNew: boolean, done: () => void): void {
    guard = 'key';
    leaveArmed = false;
    const then = (): void => {
      guard = null;
      done();
    };
    const box = section(isNew ? 'Your account key' : 'Your new key');
    const warning = paragraph(
      (isNew ? '' : 'The old key no longer works, and every other browser is logged out. ') +
        'This key is the only way into your account, on this browser or any other, and ' +
        "it can't be recovered. Save it in your password manager now.",
    );
    warning.style.color = '#ffd27a';
    const form = keyForm('save', handle, 'new-password', 'Save key');
    form.key.value = key;
    const copied = document.createElement('span');
    copied.style.cssText = 'font-size:12px;opacity:.8';
    const tools = row(
      button('Show', (b) => {
        const shown = form.key.type === 'text';
        form.key.type = shown ? 'password' : 'text';
        b.textContent = shown ? 'Show' : 'Hide';
      }),
      button('Copy', () => {
        const done = navigator.clipboard?.writeText(key);
        (done ?? Promise.reject(new Error('no clipboard'))).then(
          () => (copied.textContent = 'Copied.'),
          () => (copied.textContent = "Couldn't copy: use Show and copy it by hand."),
        );
      }),
      button('Download', () => downloadKey(handle, key)),
      copied,
    );
    const onward = button("I've saved it — continue", () => then());
    onward.style.opacity = '.8';
    form.form.onsubmit = (e): void => {
      e.preventDefault();
      // A browser's own password suggestion must not replace the key.
      if (form.key.value !== key) {
        form.key.value = key;
        say(
          "That wasn't your key — your browser offered its own password. The key is back; " +
            'save it again.',
        );
        return;
      }
      say('Saved. Your password manager should offer to keep it.');
      // Submitted, then gone: the manager's cue to save.
      then();
    };
    box.append(warning, form.form, tools, onward);
    show(box);
    form.submit.focus();
  }

  // --- logged in ----------------------------------------------------------------------

  function showAccount(account: AccountInfo): void {
    const session = state.session;
    if (!client || session === null) {
      showLoggedOut();
      return;
    }
    const summary = section(account.handle);
    summary.append(
      paragraph(
        `Rating ${ratingText(account)}${account.provisional ? ' (provisional: play rated games to settle it)' : ''}`,
      ),
      paragraph(`Record ${recordText(account)} (wins-losses-draws)`),
      paragraph(`Since ${new Date(account.createdAt).toLocaleDateString()}`),
      row(button('Leaderboard', () => nav.leaderboard())),
    );

    const rename = section('Change handle');
    const handleInput = input('text', 'new-handle', 'New handle');
    handleInput.maxLength = 32;
    handleInput.autocomplete = 'off';
    const now = Date.now();
    const renameBtn = button('Change', () => {
      const handle = normalizeHandle(handleInput.value);
      if (handle === null) {
        say('A handle needs at least one visible character (at most 16).');
        return;
      }
      if (handle === account.handle) return;
      renameBtn.disabled = true;
      client.rename(session, handle).then(
        (res) => {
          state.renamed(res.account.handle);
          say(`You're now ${res.account.handle}. A saved key still works under the old name.`);
          showAccount(res.account);
        },
        (err: unknown) => {
          say(failed(err));
          renameBtn.disabled = false;
        },
      );
    });
    const waiting = account.renameAt > now;
    renameBtn.disabled = waiting;
    handleInput.disabled = waiting;
    rename.append(
      paragraph(
        waiting
          ? `You can change it again on ${new Date(account.renameAt).toLocaleDateString()}.`
          : 'Once every 30 days. The old handle becomes free.',
      ),
      row(handleInput, renameBtn),
    );

    const keys = section('Key and session');
    // A new key takes the current one: a session alone mustn't be able to
    // mint one (it could then lock the owner out and delete the account).
    const replace = keyForm('replace', account.handle, 'current-password', 'Replace key');
    replace.form.onsubmit = (e): void => {
      e.preventDefault();
      replace.submit.disabled = true;
      client.replaceKey(session, replace.key.value).then(
        (res) => {
          say('');
          showSaveKey(account.handle, res.key, false, () => showAccount(account));
        },
        (err: unknown) => {
          say(failed(err));
          replace.submit.disabled = false;
        },
      );
    };
    const logoutBtn = button('Log out', () => {
      logoutBtn.disabled = true;
      // Log out here even if the server can't be told: the session is dropped.
      void client
        .logout(session)
        .catch(() => undefined)
        .then(() => {
          state.loggedOut();
          say('Logged out.');
          showLoggedOut();
        });
    });
    keys.append(
      paragraph(
        'A new key needs your current one, and logs out every other browser. A lost key ' +
          "can't be replaced: this browser stays logged in, but no other can log in.",
      ),
      replace.form,
      paragraph('Log out here to play as a guest.'),
      row(logoutBtn),
    );

    const danger = section('Delete account');
    const form = keyForm('delete', account.handle, 'current-password', 'Delete for good');
    form.submit.style.color = '#ff9a9a';
    form.form.onsubmit = (e): void => {
      e.preventDefault();
      form.submit.disabled = true;
      client.deleteAccount(form.key.value, session).then(
        () => {
          state.loggedOut();
          say('Your account is deleted. Its rated games now show a deleted player.');
          showLoggedOut();
        },
        (err: unknown) => {
          say(failed(err));
          form.submit.disabled = false;
        },
      );
    };
    danger.append(
      paragraph(
        'This needs the key itself, not just this browser. It removes the handle, rating ' +
          'and record; your past opponents keep their games.',
      ),
      form.form,
    );

    show(summary, rename, keys, danger);
  }

  // --- start ------------------------------------------------------------------------

  const start = async (): Promise<void> => {
    if (!client) {
      say("Accounts aren't available here.");
      return;
    }
    const session = state.session;
    if (session === null) {
      showLoggedOut();
      return;
    }
    say('Loading…');
    try {
      const { account } = await client.me(session);
      if (disposed) return;
      say('');
      state.renamed(account.handle);
      showAccount(account);
    } catch (err) {
      if (disposed) return;
      if (err instanceof AccountError && err.code === 'unauthorized') {
        state.loggedOut();
        say('Your session has ended — log in again.');
        showLoggedOut();
      } else {
        say(failed(err));
      }
    }
  };

  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.preventDefault();
      leave();
    }
  };
  globalThis.addEventListener('keydown', onKeyDown);
  void start();

  return {
    dispose(): void {
      disposed = true;
      globalThis.removeEventListener('keydown', onKeyDown);
      root.remove();
    },
  };
}

/**
 * A login-shaped form: the handle as the username, the key as the password.
 * `id` keeps the fields' ids apart when there are several on the screen.
 */
function keyForm(
  id: string,
  handle: string,
  keyAutocomplete: 'new-password' | 'current-password',
  submitLabel: string,
): { form: HTMLFormElement; key: HTMLInputElement; submit: HTMLButtonElement } {
  const form = document.createElement('form');
  form.method = 'post';
  form.autocomplete = 'on';
  form.style.cssText = 'display:flex;flex-direction:column;gap:8px';
  const user = input('text', `${id}-username`, 'Handle');
  user.name = 'username';
  user.autocomplete = 'username';
  user.value = handle;
  const key = input('password', `${id}-key`, 'eight-words-joined-by-hyphens');
  key.name = 'password';
  key.autocomplete = keyAutocomplete;
  key.required = true;
  key.spellcheck = false;
  key.autocapitalize = 'none';
  const submit = document.createElement('button');
  submit.type = 'submit';
  submit.textContent = submitLabel;
  submit.style.cssText = 'padding:6px 12px;cursor:pointer;align-self:flex-start';
  form.append(labeled('Handle', user), labeled('Key', key), submit);
  return { form, key, submit };
}

/** Save the key as a text file, for players without a password manager. */
function downloadKey(handle: string, key: string): void {
  const text =
    `Crack Attack! account\n\nHandle: ${handle}\nKey: ${key}\nSite: ${location.origin}\n\n` +
    'The key is the account. Anyone with it can play as you; lose it and the account is gone.\n';
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = 'crack-attack-key.txt';
  a.click();
  // Revoking at once can cancel the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

function section(heading: string): HTMLElement {
  const box = document.createElement('section');
  box.style.cssText =
    'display:flex;flex-direction:column;gap:8px;padding:14px;background:#161a22;' +
    'border:1px solid #2a3140;border-radius:8px';
  const h = document.createElement('h2');
  h.textContent = heading;
  h.dir = 'auto';
  h.style.cssText = 'margin:0;font-size:15px';
  box.append(h);
  return box;
}

function paragraph(text: string): HTMLParagraphElement {
  const p = document.createElement('p');
  p.textContent = text;
  p.style.cssText = 'margin:0;line-height:1.4;opacity:.9';
  return p;
}

function input(type: string, id: string, placeholder: string): HTMLInputElement {
  const el = document.createElement('input');
  el.type = type;
  el.id = `account-${id}`;
  el.placeholder = placeholder;
  el.style.cssText = 'flex:1;min-width:0;padding:6px';
  return el;
}

function labeled(text: string, control: HTMLInputElement): HTMLLabelElement {
  const label = document.createElement('label');
  label.style.cssText = 'display:flex;flex-direction:column;gap:4px;font-size:13px';
  label.append(text, control);
  return label;
}

function row(...nodes: Node[]): HTMLDivElement {
  const div = document.createElement('div');
  div.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;align-items:center';
  div.append(...nodes);
  return div;
}

function button(label: string, onClick: (b: HTMLButtonElement) => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = label;
  b.style.cssText = 'padding:6px 12px;cursor:pointer';
  b.onclick = () => onClick(b);
  return b;
}
