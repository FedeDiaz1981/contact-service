import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';

const app = express();
app.use(helmet());
app.use(express.json({ limit: '200kb' }));

// --- ENV & sanity checks ---
const apiKey = (process.env.RESEND_API_KEY || '').trim();
if (!apiKey || !apiKey.startsWith('re_')) {
  console.error('RESEND_API_KEY faltante o inválida');
  process.exit(1);
}

const fromEmail = (process.env.FROM_EMAIL || '').trim();
const toEmail = (process.env.TO_EMAIL || '').trim();

// Permitir varios orígenes separados por coma
const origins = (process.env.ALLOWED_ORIGIN || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, false); // bloquear requests sin Origin (curl, etc.)
    if (origins.length === 0 || origins.includes(origin)) return cb(null, true);
    return cb(new Error('Origen no permitido: ' + origin));
  }
}));

// --- Rate limit (10 req/min por IP sobre /contact) ---
app.use('/contact', rateLimit({ windowMs: 60_000, max: 10 }));

// --- Validación ---
const schema = z.object({
  name: z.string().min(2),
  email: z.string().email(),
  message: z.string().min(5),
  // Campos extra opcionales:
  phone: z.string().optional(),
  service: z.string().optional(),
  budget: z.string().optional()
});

app.get('/health', (_req, res) => res.send('ok'));

app.post('/contact', async (req, res) => {
  try {
    const d = schema.parse(req.body);

    // HTML/TXT personalizados
    const html = `
      <h2>Nuevo contacto</h2>
      <ul>
        <li><b>Nombre:</b> ${d.name}</li>
        <li><b>Email:</b> ${d.email}</li>
        ${d.phone ? `<li><b>Tel:</b> ${d.phone}</li>` : ''}
        ${d.service ? `<li><b>Servicio:</b> ${d.service}</li>` : ''}
        ${d.budget ? `<li><b>Presupuesto:</b> ${d.budget}</li>` : ''}
      </ul>
      <p>${d.message}</p>
    `;
    const text = `Nuevo contacto
Nombre: ${d.name}
Email: ${d.email}
${d.phone ? `Tel: ${d.phone}\n` : ''}${d.service ? `Servicio: ${d.service}\n` : ''}${d.budget ? `Presupuesto: ${d.budget}\n` : ''}${d.message}`;

    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: fromEmail,
        to: [toEmail],
        reply_to: d.email,
        subject: `Contacto: ${d.name}${d.service ? ` (${d.service})` : ''}`,
        html,
        text,
        tags: [{ name: 'form', value: 'contact' }]
      })
    });

    const txt = await r.text();
    if (!r.ok) {
      console.error('Resend error:', r.status, txt);
      return res.status(500).json({ ok: false, error: JSON.parse(txt) });
    }
    const data = JSON.parse(txt);
    return res.json({ ok: true, id: data.id ?? null });
  } catch (e) {
    const msg = e?.issues?.[0]?.message || e?.message || 'Bad request';
    return res.status(400).json({ ok: false, error: msg });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`contact-service on :${port}`);
  console.log('Resend key:', apiKey.slice(0, 8) + '…');
  console.log('Allowed origins:', origins.join(', ') || '(ninguno)');
});
