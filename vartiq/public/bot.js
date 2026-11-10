/*
 * The business assistant ("bot") setup screen: rules (keywords -> reply), a numbered menu, hand-over to a person and an
 * optional fallback, with a "try it" box. The business decides every word; there is no AI.
 */
window.createBotController = function createBotController(options) {
  'use strict';

  const { emit, toast, dialog, openPanel, onSaved } = options;

  const $ = (s) => document.querySelector(s);
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  };
  const words = (text) => String(text || '').split(/[,\n;]+/).map((x) => x.trim()).filter(Boolean);
  const clone = (x) => JSON.parse(JSON.stringify(x));

  const state = { res: null, draft: null, lastKind: null, dirty: false };

  async function open() {
    try {
      state.res = await emit('bot:get', {});
    } catch (err) {
      return toast(err.message);
    }
    state.draft = clone(state.res.bot);
    state.lastKind = null;
    state.dirty = false;
    openPanel('#panel-bot');
    render();
  }

  const touch = () => { state.dirty = true; };

  function check(label, value, onChange, hint) {
    const row = el('label', 'checkline');
    const box = el('input');
    box.type = 'checkbox';
    box.checked = !!value;
    box.addEventListener('change', () => { onChange(box.checked); touch(); render(); });
    const text = el('span', '', label);
    if (hint) text.append(el('small', 'muted bot-hint', hint));
    row.append(box, text);
    return row;
  }

  function textField(label, value, onInput, { area = false, max = 1000, hint } = {}) {
    const row = el('label', '', label);
    const input = el(area ? 'textarea' : 'input');
    if (area) input.rows = 3; else input.type = 'text';
    input.maxLength = max;
    input.value = value || '';
    input.addEventListener('input', () => { onInput(input.value); touch(); });
    row.appendChild(input);
    if (hint) row.appendChild(el('small', 'muted bot-hint', hint));
    return row;
  }

  function card(title, ...children) {
    const c = el('section', 'bot-card');
    c.appendChild(el('h3', '', title));
    for (const ch of children) if (ch) c.appendChild(ch);
    return c;
  }

  function item(title, body, onEdit, onDelete) {
    const li = el('li', 'bot-item');
    const text = el('div', 'bot-item-text');
    text.append(el('strong', '', title), el('span', 'muted', body));
    const actions = el('div', 'bot-item-actions');
    const edit = el('button', 'link', 'Edit');
    edit.type = 'button';
    edit.addEventListener('click', onEdit);
    const del = el('button', 'danger-link', 'Delete');
    del.type = 'button';
    del.addEventListener('click', () => { if (confirm('Delete this?')) { onDelete(); touch(); render(); } });
    actions.append(edit, del);
    li.append(text, actions);
    return li;
  }

  async function editRule(index) {
    const d = state.draft;
    const cur = index === null ? { keywords: [], reply: '' } : d.rules[index];
    await dialog({
      title: index === null ? 'Add a rule' : 'Edit rule',
      text: 'When a customer\'s message contains one of these words, the assistant sends this reply.',
      submit: 'Save rule',
      fields: [
        { name: 'keywords', label: 'Words, separated by commas (for example: price, cost, how much)', type: 'text', maxLength: 600, value: cur.keywords.join(', ') },
        { name: 'reply', label: 'Reply', type: 'textarea', maxLength: 1000, rows: 4, value: cur.reply },
      ],
      onSubmit(v) {
        const rule = { id: cur.id, keywords: words(v.keywords), reply: String(v.reply || '').trim() };
        if (!rule.keywords.length) throw new Error('Give at least one word');
        if (!rule.reply) throw new Error('Write the reply');
        if (index === null) d.rules.push(rule); else d.rules[index] = rule;
        touch();
      },
    });
    render();
  }

  async function editMenuItem(index) {
    const d = state.draft;
    const cur = index === null ? { label: '', reply: '' } : d.menu.items[index];
    await dialog({
      title: index === null ? 'Add a menu item' : 'Edit menu item',
      text: 'Customers see the label in the menu and answer with its number.',
      submit: 'Save item',
      fields: [
        { name: 'label', label: 'Label (for example: Opening hours)', type: 'text', maxLength: 60, value: cur.label },
        { name: 'reply', label: 'Reply', type: 'textarea', maxLength: 1000, rows: 4, value: cur.reply },
      ],
      onSubmit(v) {
        const it = { label: String(v.label || '').trim(), reply: String(v.reply || '').trim() };
        if (!it.label || !it.reply) throw new Error('Write both the label and the reply');
        if (index === null) d.menu.items.push(it); else d.menu.items[index] = it;
        touch();
      },
    });
    render();
  }

  function tryBox() {
    const box = el('div', 'bot-try');
    const form = el('form', 'bot-try-form');
    const input = el('input');
    input.type = 'text';
    input.placeholder = 'Type what a customer might write';
    input.maxLength = 300;
    const go = el('button', 'primary small', 'Try it');
    go.type = 'submit';
    form.append(input, go);
    const out = el('div', 'bot-try-out muted', 'Nothing is sent: this only shows the reply.');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!input.value.trim()) return;
      try {
        const res = await emit('bot:test', { text: input.value, afterMenu: state.lastKind === 'menu', config: state.draft });
        state.lastKind = res.reply?.kind || null;
        out.textContent = res.reply ? res.reply.text : 'No reply: nothing matches (customers get silence).';
        out.className = `bot-try-out${res.reply ? ' bubble-preview' : ' muted'}`;
      } catch (err) {
        out.textContent = err.message;
        out.className = 'bot-try-out error';
      }
    });
    box.append(form, out);
    return box;
  }

  async function save() {
    try {
      const res = await emit('bot:set', state.draft);
      state.draft = clone(res.bot);
      state.res.bot = res.bot;
      state.dirty = false;
      toast(res.bot.enabled ? 'Assistant is on' : 'Assistant saved (off)');
      onSaved?.(res.bot, res.user);
      render();
    } catch (err) {
      toast(err.message);
    }
  }

  function render() {
    const d = state.draft;
    const lim = state.res.limits;
    const box = $('#bot-body');
    box.textContent = '';

    if (!state.res.available) box.appendChild(el('p', 'error', 'The administrator has switched the assistant off, so it cannot answer now.'));
    box.appendChild(el('p', 'muted', 'The assistant answers customers when their message matches something you set up here. You decide every word: there is no artificial intelligence. If nothing matches, it stays silent.'));
    if (d.enabled) {
      box.appendChild(el('p', 'bot-warn', 'While the assistant is on, customers\' messages to your business are not end-to-end encrypted (the assistant has to read them). Customers are told so in the chat.'));
    }

    box.appendChild(card('Assistant',
      check('Answer customers automatically', d.enabled, (v) => { d.enabled = v; }),
      check('Only when we are closed', d.onlyWhenClosed, (v) => { d.onlyWhenClosed = v; }, 'Uses the opening hours of your business profile'),
    ));

    const rules = el('ul', 'bot-list');
    d.rules.forEach((r, i) => rules.appendChild(item(r.keywords.join(', '), r.reply, () => editRule(i), () => d.rules.splice(i, 1))));
    const addRule = el('button', 'primary small', 'Add a rule');
    addRule.type = 'button';
    addRule.addEventListener('click', () => {
      if (d.rules.length >= lim.rules) return toast(lim.premium ? `At most ${lim.rules} rules` : `Free business accounts can have ${lim.rules} rules. Premium allows ${lim.premiumRules}.`);
      editRule(null);
    });
    box.appendChild(card(`Rules (${d.rules.length} of ${lim.rules})`,
      el('p', 'muted', 'A word matches when it appears in the customer\'s message; several words in a row (like "how much") must appear together. The first matching rule answers.'),
      rules, addRule));

    const menuItems = el('ul', 'bot-list');
    d.menu.items.forEach((it, i) => menuItems.appendChild(item(`${i + 1}. ${it.label}`, it.reply, () => editMenuItem(i), () => d.menu.items.splice(i, 1))));
    const addItem = el('button', 'primary small', 'Add a menu item');
    addItem.type = 'button';
    addItem.addEventListener('click', () => { if (d.menu.items.length >= lim.menuItems) return toast(`At most ${lim.menuItems} items`); editMenuItem(null); });
    box.appendChild(card('Menu',
      check('Offer a numbered menu', d.menu.enabled, (v) => { d.menu.enabled = v; }),
      textField('Words that show the menu (commas)', d.menu.keywords.join(', '), (v) => { d.menu.keywords = words(v); }, { max: 200 }),
      textField('Introduction', d.menu.intro, (v) => { d.menu.intro = v; }, { max: 200 }),
      menuItems, addItem));

    const pause = el('label', '', 'The assistant then stays quiet in that chat for');
    const sel = el('select');
    for (const h of lim.pauseHours) sel.appendChild(new Option(h === 1 ? '1 hour' : h >= 24 ? `${h / 24} day${h === 24 ? '' : 's'}` : `${h} hours`, h));
    sel.value = d.handoff.pauseHours;
    sel.addEventListener('change', () => { d.handoff.pauseHours = Number(sel.value); touch(); });
    pause.appendChild(sel);
    box.appendChild(card('Hand over to a person',
      check('Let customers ask for a person', d.handoff.enabled, (v) => { d.handoff.enabled = v; }),
      textField('Words that ask for a person (commas)', d.handoff.keywords.join(', '), (v) => { d.handoff.keywords = words(v); }, { max: 200 }),
      textField('Message', d.handoff.reply, (v) => { d.handoff.reply = v; }, { area: true }),
      pause,
      el('small', 'muted bot-hint', 'The assistant also stays out of a chat for an hour after one of you writes there.')));

    box.appendChild(card('When nothing matches',
      check('Send a message', d.fallback.enabled, (v) => { d.fallback.enabled = v; }, 'At most once every 6 hours in a chat'),
      textField('Message', d.fallback.text, (v) => { d.fallback.text = v; }, { area: true })));

    box.appendChild(card('Try it', tryBox()));

    const save$ = el('button', 'primary', d.enabled ? 'Save and turn on' : 'Save');
    save$.type = 'button';
    save$.addEventListener('click', save);
    box.appendChild(save$);
  }

  return { open };
};
