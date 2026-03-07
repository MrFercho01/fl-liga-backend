import nodemailer from 'nodemailer'

type ClientAccessCredentialsEmailPayload = {
  to: string
  clientName: string
  organizationName?: string
  accessToken: string
  temporaryPassword: string
  expiresAt: string
}

const smtpHost = process.env.SMTP_HOST?.trim()
const smtpPort = Number(process.env.SMTP_PORT ?? 587)
const smtpUser = process.env.SMTP_USER?.trim()
const smtpPass = process.env.SMTP_PASS?.trim()
const smtpFrom = process.env.SMTP_FROM?.trim()

const parseBooleanEnv = (value?: string) => {
  if (typeof value !== 'string') return null

  const normalized = value.trim().toLowerCase()
  if (['true', '1', 'yes', 'on'].includes(normalized)) return true
  if (['false', '0', 'no', 'off'].includes(normalized)) return false

  return null
}

const assertSmtpConfig = () => {
  if (!smtpHost || !smtpUser || !smtpPass || !smtpFrom) {
    throw new Error('SMTP no configurado. Define SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS y SMTP_FROM.')
  }

  if (!Number.isFinite(smtpPort) || smtpPort <= 0) {
    throw new Error('SMTP_PORT inválido.')
  }
}

const buildTransporter = () => {
  assertSmtpConfig()

  const secureFromEnv = parseBooleanEnv(process.env.SMTP_SECURE)
  const smtpSecure = secureFromEnv === null ? smtpPort === 465 : secureFromEnv

  const requireTlsFromEnv = parseBooleanEnv(process.env.SMTP_REQUIRE_TLS)
  const requireTLS = requireTlsFromEnv === null ? (!smtpSecure && smtpPort === 587) : requireTlsFromEnv

  const rejectUnauthorizedFromEnv = parseBooleanEnv(process.env.SMTP_TLS_REJECT_UNAUTHORIZED)
  const tlsRejectUnauthorized = rejectUnauthorizedFromEnv === null ? true : rejectUnauthorizedFromEnv

  const connectionTimeout = Number(process.env.SMTP_CONNECTION_TIMEOUT ?? 20000)
  const greetingTimeout = Number(process.env.SMTP_GREETING_TIMEOUT ?? 15000)
  const socketTimeout = Number(process.env.SMTP_SOCKET_TIMEOUT ?? 25000)

  return nodemailer.createTransport({
    host: smtpHost,
    port: smtpPort,
    secure: smtpSecure,
    requireTLS,
    connectionTimeout,
    greetingTimeout,
    socketTimeout,
    tls: {
      rejectUnauthorized: tlsRejectUnauthorized,
    },
    auth: {
      user: smtpUser,
      pass: smtpPass,
    },
  })
}

export const sendClientAccessCredentialsEmail = async (payload: ClientAccessCredentialsEmailPayload) => {
  const transporter = buildTransporter()
  const loginUrl = process.env.FRONTEND_LOGIN_URL?.trim() || 'https://tu-frontend.com'

  const organizationLine = payload.organizationName ? `<p><strong>Empresa/Liga:</strong> ${payload.organizationName}</p>` : ''

  const info = await transporter.sendMail({
    from: smtpFrom,
    to: payload.to,
    subject: 'FL Liga · Token de acceso y contraseña temporal',
    html: `
      <div style="font-family: Arial, sans-serif; color: #0f172a; line-height: 1.5;">
        <h2 style="margin-bottom: 8px;">Hola ${payload.clientName},</h2>
        <p>Se generó tu acceso de cliente administrador para FL Liga.</p>
        ${organizationLine}
        <p><strong>Token de acceso:</strong> ${payload.accessToken}</p>
        <p><strong>Contraseña temporal:</strong> ${payload.temporaryPassword}</p>
        <p><strong>Caduca:</strong> ${new Date(payload.expiresAt).toLocaleString('es-EC')}</p>
        <p>Al ingresar por primera vez, deberás validar el token y cambiar la contraseña temporal.</p>
        <p>
          URL de acceso: <a href="${loginUrl}" target="_blank" rel="noreferrer">${loginUrl}</a>
        </p>
      </div>
    `,
    text: [
      `Hola ${payload.clientName},`,
      'Se generó tu acceso de cliente administrador para FL Liga.',
      payload.organizationName ? `Empresa/Liga: ${payload.organizationName}` : '',
      `Token de acceso: ${payload.accessToken}`,
      `Contraseña temporal: ${payload.temporaryPassword}`,
      `Caduca: ${new Date(payload.expiresAt).toLocaleString('es-EC')}`,
      'Al ingresar por primera vez, deberás validar el token y cambiar la contraseña temporal.',
      `URL de acceso: ${loginUrl}`,
    ]
      .filter(Boolean)
      .join('\n'),
  })

  return {
    messageId: info.messageId,
    accepted: info.accepted,
    rejected: info.rejected,
  }
}
