/* A saved page is a copy, not proof of current publication. No tracking/storage. */
(() => {
  const status = document.getElementById('editorial-copy-status');
  if (!status) return;
  const version = document.querySelector('meta[name="izz-editorial-version"]')?.content;
  let pending = false;
  const show = (message, reload) => {
    status.replaceChildren(document.createTextNode(message + ' '));
    status.hidden = false;
    if (reload) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = 'Încarcă versiunea actuală';
      button.addEventListener('click', () => location.reload());
      status.append(button);
    }
  };
  const check = async () => {
    if (!navigator.onLine) {
      show('Copie salvată; actualitatea nu poate fi verificată fără conexiune.', false);
      return;
    }
    if (pending) return;
    pending = true;
    try {
      const response = await fetch('/editorial-revisions.json', {cache: 'no-store'});
      if (!response.ok) throw new Error('version unavailable');
      const manifest = await response.json();
      if (manifest.schema_version !== 1 || typeof manifest.version !== 'string') {
        throw new Error('invalid version signal');
      }
      if (!navigator.onLine) {
        show('Copie salvată; actualitatea nu poate fi verificată fără conexiune.', false);
      } else if (manifest.version !== version) {
        show('Există o versiune editorială mai nouă a site-ului. Această copie poate fi depășită.', true);
      } else {
        status.hidden = true;
      }
    } catch {
      show('Actualitatea acestei copii nu a putut fi verificată.', false);
    } finally {
      pending = false;
    }
  };
  addEventListener('online', check);
  addEventListener('offline', check);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) check(); });
  check();
})();
