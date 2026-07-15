const crypto = require('crypto');

const messages = new Map();
const campaigns = new Map();

function createCampaign(channel, total) {
    const id = crypto.randomUUID();

    campaigns.set(id, {
        id,
        channel,
        total,
        createdAt: new Date().toISOString()
    });

    return id;
}

function recordOutbound({ sid, campaignId, name, contact, channel, status, error }) {
    if (!sid) return;

    messages.set(sid, {
        sid,
        campaignId: campaignId || null,
        direction: 'outbound',
        name: name || 'Unknown',
        contact,
        channel,
        status: status || (error ? 'failed' : 'queued'),
        error: error || null,
        body: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
    });
}

function updateStatus(sid, status, errorCode) {
    const record = messages.get(sid);

    if (!record) {
        return null;
    }

    record.status = status;
    record.error = errorCode ? `Error ${errorCode}` : record.error;
    record.updatedAt = new Date().toISOString();

    return record;
}

function recordInbound({ sid, from, to, channel, body }) {
    const key = sid || crypto.randomUUID();

    messages.set(key, {
        sid: key,
        campaignId: null,
        direction: 'inbound',
        name: null,
        contact: from,
        to,
        channel,
        status: 'received',
        error: null,
        body: body || '',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
    });
}

function listLogs({ limit = 200, campaignId } = {}) {
    let records = Array.from(messages.values());

    if (campaignId) {
        records = records.filter(record => record.campaignId === campaignId);
    }

    return records
        .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))
        .slice(0, limit);
}

function listCampaigns() {
    return Array.from(campaigns.values())
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

module.exports = {
    createCampaign,
    recordOutbound,
    updateStatus,
    recordInbound,
    listLogs,
    listCampaigns
};
