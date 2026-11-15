const saveButton = document.querySelector('#offline-save');
const updateButton = document.querySelector('#check-update');
const status = document.querySelector('#offline-status');

if (saveButton && updateButton && status) {
  setupOffline();
}

async function setupOffline() {
  const show = (message) => { status.textContent = message; };
  const busy = (active) => {
    saveButton.disabled = active;
    updateButton.disabled = active;
  };

  if (!('serviceWorker' in navigator) || !window.isSecureContext) {
    busy(true);
    show('オフライン保存は、HTTPSで開いたときに利用できます。');
    return;
  }

  busy(true);
  try {
    await navigator.serviceWorker.register(new URL('sw.js', import.meta.url), {updateViaCache: 'none'});
    const registration = await navigator.serviceWorker.ready;

    function send(kind) {
      return new Promise((resolve, reject) => {
        const channel = new MessageChannel();
        let timeout;
        const keepAlive = () => {
          clearTimeout(timeout);
          timeout = setTimeout(() => {
            channel.port1.close();
            reject(new Error('応答がありません。通信環境を確認して再試行してください。'));
          }, 240000);
        };
        keepAlive();
        channel.port1.onmessage = ({data}) => {
          if (data.kind === 'progress') {
            keepAlive();
            show('保存中 ' + data.done + ' / ' + data.total);
            return;
          }
          clearTimeout(timeout);
          channel.port1.close();
          if (data.kind === 'error') reject(new Error(data.message));
          else resolve(data);
        };
        const worker = registration.active;
        if (!worker) {
          clearTimeout(timeout);
          channel.port1.close();
          reject(new Error('オフライン機能を準備中です。少し待って再試行してください。'));
          return;
        }
        worker.postMessage({kind}, [channel.port2]);
      });
    }

    async function perform(kind) {
      busy(true);
      const messages = {
        save: '収録データを保存しています…',
        update: '公開データの更新を確認しています…'
      };
      if (messages[kind]) show(messages[kind]);
      try {
        const result = await send(kind);
        if (result.changed) {
          show('更新を適用しました。画面を再読み込みします。');
          window.location.reload();
          return;
        }
        const date = result.date ? ' · ' + result.date : '';
        show(result.full
          ? '収録データをオフライン保存済み' + date
          : kind === 'update' ? '公開版を確認しました' + date
          : 'オフライン用に保存できます');
      } catch (error) {
        show(kind === 'prepare' && !navigator.onLine ? 'オフラインで閲覧中' : error.message);
      } finally {
        busy(false);
      }
    }

    saveButton.addEventListener('click', () => {
      if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
      perform('save');
    });
    updateButton.addEventListener('click', () => perform('update'));
    await perform('prepare');
  } catch {
    show('このブラウザではオフライン保存を開始できませんでした。');
  }
}
