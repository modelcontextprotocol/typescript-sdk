// @ts-check
// The live board page's script, shipped as its own Text module so the repo's
// lint/format gates see it (an inline <script> is invisible to them). The
// worker inlines it into board.html at render time via the __BOARD_SCRIPT__
// marker. Contract with the worker: /board/events emits one `info` event
// ({ mode: 'named'|'oauth'|'address', label }) and then a snapshot per change.
const identity = document.querySelector('#identity');
const list = document.querySelector('#tasks');
const empty = document.querySelector('#empty');
const status = document.querySelector('#status');
const namedBoard = new URLSearchParams(location.search).get('b');
// Opened from the consent click, this tab races the approval POST: the
// viewer cookie for the NEW grant lands with the approve response, which
// may arrive after this page. #claim defers the first connection so the
// cookie is in place, instead of resolving to a previous grant's board.
const claiming = location.hash === '#claim' && !namedBoard;
let source;
let retried = false;

function renderInfo(info) {
    identity.textContent =
        info.mode === 'oauth'
            ? `You are OAuthed: this is the private board granted to ${info.label}.`
            : info.mode === 'named'
              ? `Shared board "${info.label}" — anyone with this link (and any client sending X-Todos-Board: ${info.label}) sees it.`
              : 'Your address-keyed board (no OAuth grant, no ?b= name).';
}

function onSnapshot(event) {
    const snapshot = JSON.parse(event.data);
    const tasks = snapshot.tasks ?? [];
    list.replaceChildren(
        ...tasks.map(task => {
            const item = document.createElement('li');
            item.textContent = `${task.title} (${task.id}, ${task.project}${task.priority ? ', ' + task.priority : ''})`;
            if (task.status === 'done') item.classList.add('done');
            return item;
        })
    );
    empty.hidden = tasks.length > 0;
}

function connect() {
    source = new EventSource('/board/events' + location.search);
    source.onopen = () => {
        status.textContent = 'live';
    };
    source.onerror = () => {
        status.textContent = 'reconnecting…';
    };
    source.onmessage = onSnapshot;
    source.addEventListener('info', event => {
        const info = JSON.parse(event.data);
        // Opened straight from consent, the viewer cookie can land a moment
        // after this page: if we resolved to the address fallback, try once
        // more before accepting it.
        if (info.mode === 'address' && !namedBoard && !retried) {
            retried = true;
            status.textContent = 'claiming your board…';
            source.close();
            setTimeout(connect, 1200);
            return;
        }
        renderInfo(info);
    });
}
if (claiming) {
    status.textContent = 'claiming your board…';
    identity.textContent = 'finishing authorization…';
    setTimeout(connect, 1500);
} else {
    connect();
}
