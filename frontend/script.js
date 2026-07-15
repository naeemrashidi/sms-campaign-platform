const form = document.getElementById('campaignForm');
const sendBtn = document.getElementById('sendBtn');
const stopBtn = document.getElementById('stopBtn');
const status = document.getElementById('status');
const logTableBody = document.getElementById('logTableBody');

const LOG_POLL_INTERVAL_MS = 5000;
let activeController = null;

form.addEventListener('submit', sendMessage);
stopBtn.addEventListener('click', stopMessage);
refreshLogs();
setInterval(refreshLogs, LOG_POLL_INTERVAL_MS);

function setSendingState(isSending) {
    sendBtn.disabled = isSending;
    stopBtn.disabled = !isSending;
}

function stopMessage() {
    if (activeController) {
        activeController.abort();
    }
}

async function sendMessage(e) {
    e.preventDefault();
    const file =
        document.getElementById('excel').files[0];
    const message =
        document.getElementById('message').value;
    const channel =
        document.getElementById('channel').value;


    const formData = new FormData();
    if (!file) {
        alert('Please choose an Excel file first.');
        return;
    }

    if (activeController) {
        activeController.abort();
    }

    activeController = new AbortController();
    setSendingState(true);
    status.innerHTML = '<p>Sending campaign...</p>';

    formData.append('file', file);
    formData.append('message', message);
    formData.append('channel', channel);

    try {
        const response = await fetch(`/send-message`, {
            method: 'POST',
            body: formData,
            signal: activeController.signal
        });

        const data = await response.json();
        status.innerHTML = `
            <p>${data.message}</p>
            <p>Channel: ${String(data.channel || channel).toUpperCase()}</p>
            <p>Total Contacts: ${data.total}</p>
            <p>Delivery Attempts: ${data.attempts ?? data.total}</p>
            <p>Messages Sent: ${data.sent}</p>
            <p>Messages Failed: ${data.failed}</p>
        `;
        form.reset();

    } catch (error) {
        if (error.name === 'AbortError') {
            status.innerHTML = '<p>Campaign stopped.</p>';
        } else {
            status.innerHTML = `<p>Failed to send campaign: ${error.message}</p>`;
        }
    } finally {
        activeController = null;
        setSendingState(false);
        refreshLogs();
    }
}

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

async function refreshLogs() {
    try {
        const response = await fetch('/logs');
        const data = await response.json();
        const logs = data.logs || [];

        logTableBody.innerHTML = logs.map(log => `
            <tr>
                <td>${new Date(log.updatedAt).toLocaleTimeString()}</td>
                <td>${escapeHtml(log.direction)}</td>
                <td>${escapeHtml(log.channel)}</td>
                <td>${escapeHtml(log.contact)}</td>
                <td>${escapeHtml(log.status)}</td>
                <td>${escapeHtml(log.error)}</td>
            </tr>
        `).join('');
    } catch (error) {
        console.error('Failed to refresh logs:', error.message);
    }
}
