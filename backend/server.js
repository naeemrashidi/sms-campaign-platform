require('dotenv').config();

const express = require('express');
const multer = require('multer');
const path = require('path');
const XLSX = require('xlsx');
const twilio = require('twilio');
const pLimit = require('p-limit');
const store = require('./store');

const app = express();
const PORT = Number(process.env.PORT) || 4000;
const FRONTEND_DIR = path.join(__dirname, '..', 'frontend');
const DEFAULT_MESSAGE = 'Test campaign';
const MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024;
const MAX_BODY_SIZE = '100kb';
const CONCURRENCY_LIMIT = 20;
const VALID_CHANNELS = new Set(['sms', 'whatsapp', 'both']);
const IS_PRODUCTION = process.env.NODE_ENV === 'production';

const ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || process.env.ACCOUNT_SID;
const AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || process.env.AUTH_TOKEN;

// SMS and WhatsApp are separate Twilio channels and can be backed by
// different Messaging Services. SMS_SERVICE_SID falls back to the legacy
// SERVICE_SID name so existing deployments keep working unchanged.
const SMS_SERVICE_SID = process.env.SMS_SERVICE_SID || process.env.SERVICE_SID;
const WHATSAPP_SERVICE_SID = process.env.WHATSAPP_SERVICE_SID || '';
const WHATSAPP_FROM = process.env.WHATSAPP_FROM || '';
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');

if (!ACCOUNT_SID || !AUTH_TOKEN || !SMS_SERVICE_SID) {
    throw new Error(
        'Missing required Twilio environment variables. ' +
        'Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and SMS_SERVICE_SID.'
    );
}

if (!WHATSAPP_SERVICE_SID && !WHATSAPP_FROM) {
    console.warn(
        'WHATSAPP_SERVICE_SID/WHATSAPP_FROM not set. ' +
        'WhatsApp sends will fail until a working WhatsApp sender is configured.'
    );
}

const client = twilio(ACCOUNT_SID, AUTH_TOKEN);
const limit = pLimit(CONCURRENCY_LIMIT);
const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: MAX_FILE_SIZE_BYTES
    }
});

app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(express.json({ limit: MAX_BODY_SIZE }));
app.use(express.urlencoded({ extended: false, limit: MAX_BODY_SIZE }));
app.use(express.static(FRONTEND_DIR, { extensions: ['html'] }));

function normalizeChannel(channel) {
    const normalized = String(channel || 'sms').trim().toLowerCase();

    if (!VALID_CHANNELS.has(normalized)) {
        throw new Error('Channel must be one of SMS, WhatsApp, or Both.');
    }

    return normalized;
}

function normalizeContactValue(value) {
    return String(value || '').trim();
}

function pickRowValue(row, keys) {
    for (const key of keys) {
        if (row[key] !== undefined && row[key] !== null && String(row[key]).trim() !== '') {
            return row[key];
        }
    }

    return '';
}

function readContactsFromBuffer(buffer) {
    const workbook = XLSX.read(buffer, { type: 'buffer' });

    if (!workbook.SheetNames.length) {
        throw new Error('The uploaded Excel file does not contain any sheets.');
    }

    const sheetName = workbook.SheetNames[0];
    const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], {
        defval: ''
    });

    if (!rows.length) {
        throw new Error('The uploaded Excel sheet does not contain any rows.');
    }

    return rows.map(row => ({
        NAME: normalizeContactValue(pickRowValue(row, ['NAME', 'Name', 'name'])) || 'Unknown',
        CONTACT: normalizeContactValue(pickRowValue(row, ['CONTACT', 'Contact', 'contact', 'PHONE', 'Phone', 'phone', 'MOBILE', 'Mobile', 'mobile'])),
        LINK: normalizeContactValue(pickRowValue(row, ['LINK', 'Link', 'link'])),
        PROMO_CODE: normalizeContactValue(pickRowValue(row, ['PROMO_CODE', 'PromoCode', 'promo_code', 'PROMO CODE']))
    }));
}

function applyTemplate(template, user) {
    return String(template)
        .replace(/\{\{\s*name\s*\}\}/gi, user.NAME || '')
        .replace(/\{\{\s*link\s*\}\}/gi, user.LINK || '')
        .replace(/\{\{\s*promo_code\s*\}\}/gi, user.PROMO_CODE || '');
}

function resolveSendParams(channel, recipient) {
    if (channel === 'whatsapp') {
        if (WHATSAPP_SERVICE_SID) {
            return { messagingServiceSid: WHATSAPP_SERVICE_SID, to: recipient };
        }

        if (WHATSAPP_FROM) {
            return { from: WHATSAPP_FROM, to: recipient };
        }

        throw new Error('WhatsApp sending is not configured yet. Set WHATSAPP_SERVICE_SID or WHATSAPP_FROM.');
    }

    return { messagingServiceSid: SMS_SERVICE_SID, to: recipient };
}

function buildRecipientAddress(rawContact, channel) {
    const contact = normalizeContactValue(rawContact);
    const hasWhatsAppPrefix = /^whatsapp:/i.test(contact);

    if (!contact) {
        throw new Error('Contact number is missing.');
    }

    if (channel === 'whatsapp') {
        return hasWhatsAppPrefix ? contact : `whatsapp:${contact}`;
    }

    return hasWhatsAppPrefix ? contact.replace(/^whatsapp:/i, '') : contact;
}

async function sendOne(user, messageBody, channel, campaignId) {
    const name = user.NAME || 'Unknown';
    const rawContact = user.CONTACT;

    try {
        const recipient = buildRecipientAddress(rawContact, channel);
        const sendParams = resolveSendParams(channel, recipient);
        const personalizedBody = applyTemplate(messageBody, user);

        const message = await client.messages.create({
            body: personalizedBody,
            ...sendParams,
            ...(PUBLIC_BASE_URL ? { statusCallback: `${PUBLIC_BASE_URL}/twilio/status` } : {})
        });

        store.recordOutbound({
            sid: message.sid,
            campaignId,
            name,
            contact: rawContact,
            channel,
            status: message.status
        });

        return {
            name,
            contact: rawContact,
            channel,
            sid: message.sid,
            status: message.status
        };
    } catch (error) {
        return {
            name,
            contact: rawContact,
            channel,
            error: error.message
        };
    }
}

function createCancellationState(req) {
    const state = {
        cancelled: false
    };

    const markCancelled = () => {
        state.cancelled = true;
    };

    req.on('aborted', markCancelled);
    req.on('close', () => {
        if (!req.complete) {
            markCancelled();
        }
    });

    return state;
}

async function sendBulkMessages(users, messageBody, channel, cancellationState, campaignId) {
    const channelsToSend = channel === 'both' ? ['sms', 'whatsapp'] : [channel];

    const tasks = users.flatMap(user =>
        channelsToSend.map(selectedChannel =>
            limit(async () => {
                if (cancellationState.cancelled) {
                    return null;
                }

                return sendOne(user, messageBody, selectedChannel, campaignId);
            })
        )
    );

    const results = await Promise.all(tasks);
    return results.filter(Boolean);
}

function sendJsonError(res, statusCode, message) {
    return res.status(statusCode).json({ message });
}

function buildWebhookTwiML() {
    return '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';
}

app.get('/health', (_req, res) => {
    res.status(200).json({
        status: 'ok'
    });
});

app.post('/twilio/incoming', (req, res) => {
    res.type('xml');

    const from = normalizeContactValue(req.body?.From);
    const to = normalizeContactValue(req.body?.To);
    const body = normalizeContactValue(req.body?.Body);

    if (!from || !to || !body) {
        return res.status(200).send(buildWebhookTwiML());
    }

    const channel = /^whatsapp:/i.test(from) ? 'whatsapp' : 'sms';
    const messageSid = normalizeContactValue(req.body?.MessageSid) || normalizeContactValue(req.body?.SmsSid);

    store.recordInbound({ sid: messageSid, from, to, channel, body });

    return res.status(200).send(buildWebhookTwiML());
});

app.post('/twilio/status', (req, res) => {
    const sid = normalizeContactValue(req.body?.MessageSid) || normalizeContactValue(req.body?.SmsSid);
    const status = normalizeContactValue(req.body?.MessageStatus);
    const errorCode = normalizeContactValue(req.body?.ErrorCode);

    if (sid && status) {
        store.updateStatus(sid, status, errorCode || null);
    }

    res.status(200).send();
});

app.get('/logs', (req, res) => {
    const campaignId = normalizeContactValue(req.query?.campaignId) || undefined;

    res.status(200).json({
        logs: store.listLogs({ campaignId }),
        campaigns: store.listCampaigns()
    });
});

app.get('/', (_req, res) => {
    res.sendFile(path.join(FRONTEND_DIR, 'index.html'));
});

app.post('/send-message', upload.single('file'), async (req, res, next) => {
    try {
        if (!req.file) {
            return sendJsonError(res, 400, 'Please upload an Excel file.');
        }

        const messageBody = String(req.body.message || DEFAULT_MESSAGE).trim();
        const channel = normalizeChannel(req.body.channel);

        if (!messageBody) {
            return sendJsonError(res, 400, 'Message body cannot be empty.');
        }

        const users = readContactsFromBuffer(req.file.buffer);
        const invalidContacts = users.filter(user => !user.CONTACT);

        if (invalidContacts.length) {
            return sendJsonError(
                res,
                400,
                'The uploaded Excel file must include a CONTACT column with values.'
            );
        }

        const campaignId = store.createCampaign(channel, users.length);
        const cancellationState = createCancellationState(req);
        const results = await sendBulkMessages(users, messageBody, channel, cancellationState, campaignId);

        if (cancellationState.cancelled) {
            return;
        }

        const sentCount = results.filter(result => result.sid).length;
        const failedCount = results.length - sentCount;
        const attemptCount = results.length;

        return res.status(200).json({
            message: `Campaign processed for ${attemptCount} delivery attempt(s) using ${channel.toUpperCase()}.`,
            campaignId,
            total: users.length,
            attempts: attemptCount,
            sent: sentCount,
            failed: failedCount,
            channel,
            results
        });
    } catch (error) {
        if (error.code === 'ERR_HTTP_REQUEST_ABORTED') {
            return;
        }

        next(error);
    }
});

app.use((error, _req, res, _next) => {
    const statusCode = error.code === 'LIMIT_FILE_SIZE' ? 413 : 500;
    const message = error.code === 'LIMIT_FILE_SIZE'
        ? 'The uploaded file is too large.'
        : (IS_PRODUCTION && statusCode === 500
            ? 'Something went wrong while processing the request.'
            : error.message || 'Something went wrong while processing the request.');

    res.status(statusCode).json({
        message
    });
});

const server = app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
});

function shutdown(signal) {
    console.log(`Received ${signal}. Shutting down gracefully.`);

    server.close(() => {
        process.exit(0);
    });

    setTimeout(() => {
        console.error('Forced shutdown after timeout.');
        process.exit(1);
    }, 10_000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

process.on('unhandledRejection', error => {
    console.error('Unhandled promise rejection:', error);
});

process.on('uncaughtException', error => {
    console.error('Uncaught exception:', error);
    process.exit(1);
});
