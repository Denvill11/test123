document.getElementById('createRoom').addEventListener('click', () => {
  const pass = document.getElementById('roomPassInput').value.trim();
  const q = pass ? `?pass=${encodeURIComponent(pass)}` : '';
  window.location.href = '/new' + q;
});

document.getElementById('joinRoom').addEventListener('click', () => {
  const raw = document.getElementById('roomIdInput').value.trim();
  if (!raw) return;
  const extractRoomId = (input) => {
    try {
      const url = new URL(input);
      const parts = url.pathname.split('/').filter(Boolean);
      return parts[parts.length - 1] || '';
    } catch (_) {
      const parts = input.split('/').filter(Boolean);
      return parts[parts.length - 1] || '';
    }
  };
  const roomId = extractRoomId(raw);
  if (!roomId) return;
  window.location.href = `/room/${encodeURIComponent(roomId)}`;
});

(() => {
  const word = 'Cumchatka';
  const typeWordEl = document.getElementById('typeWord');
  const caretEl = document.getElementById('typeCaret');
  const nickInput = document.getElementById('nickInputInline');
  if (!typeWordEl || !caretEl) return;
  if (nickInput) {
    nickInput.setAttribute('autocomplete', 'off');
    nickInput.setAttribute('autocorrect', 'off');
    nickInput.setAttribute('autocapitalize', 'off');
    nickInput.setAttribute('spellcheck', 'false');
  }

  let i = 0;
  const typeDelay = 90;
  const eraseDelay = 140;

  const type = () => {
    if (i <= word.length) {
      typeWordEl.textContent = word.slice(0, i);
      i++;
      setTimeout(type, typeDelay);
    } else {
      setTimeout(erase, 600);
    }
  };

  const erase = () => {
    if (i >= 0) {
      typeWordEl.textContent = word.slice(0, i);
      i--;
      setTimeout(erase, eraseDelay);
    } else {
      if (nickInput) {
        nickInput.style.display = 'block';
        nickInput.style.position = 'absolute';
        nickInput.style.opacity = '0';
        nickInput.style.width = '0';
        nickInput.style.height = '0';
        nickInput.style.border = '0';
        nickInput.style.padding = '0';
        nickInput.style.margin = '0';
        nickInput.style.outline = '0';
        nickInput.style.pointerEvents = 'none';
        nickInput.focus();
      }
    }
  };

  nickInput?.addEventListener('input', () => {
    const nick = (nickInput.value || '').trim();
    typeWordEl.textContent = nick;
    try { localStorage.setItem('userNick', nick); } catch (_) {}
  });

  const maybeHideCaret = () => {
    const nick = (typeWordEl.textContent || '').trim();
    if (nick) {
      caretEl.style.display = 'none';
    }
  };
  nickInput?.addEventListener('blur', maybeHideCaret);
  nickInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === 'Tab') {
      setTimeout(maybeHideCaret, 0);
    }
  });

  nickInput?.addEventListener('focus', () => {
    caretEl.style.display = 'inline-block';
  });

  const titleEl = document.getElementById('typeTitle');
  titleEl?.addEventListener('click', () => {
    nickInput?.focus();
  });

  document.addEventListener('keydown', (e) => {
    if (!nickInput) return;
    const active = document.activeElement && document.activeElement.tagName;
    if (active === 'INPUT' || active === 'TEXTAREA') return;
    if (e.key.length === 1) {
      e.preventDefault();
      nickInput.focus();
      caretEl.style.display = 'inline-block';
      nickInput.value = (nickInput.value || '') + e.key;
      typeWordEl.textContent = nickInput.value.trim();
    } else if (e.key === 'Backspace') {
      e.preventDefault();
      nickInput.focus();
      caretEl.style.display = 'inline-block';
      nickInput.value = (nickInput.value || '').slice(0, -1);
      typeWordEl.textContent = nickInput.value.trim();
    }
  });

  setTimeout(type, 300);
})();


