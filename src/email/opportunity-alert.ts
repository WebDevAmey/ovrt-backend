import { Resend } from 'resend'

const resend = new Resend(process.env.RESEND_API_KEY)
const companyName = process.env.COMPANY_NAME ?? 'Ovrt'

const CATEGORY_LABEL: Record<string, string> = {
  MARKETING: 'Marketing',
  COMMUNICATION: 'Communication',
  PRICING: 'Pricing',
  PRODUCT: 'Product',
  RETENTION: 'Retention',
  OPERATIONS: 'Operations',
  CUSTOMER_EXPERIENCE: 'Customer Experience',
  INVENTORY: 'Inventory',
  ACQUISITION: 'Acquisition',
  OTHER: 'Opportunity',
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function opportunityCard(o: { title: string; description: string; category: string }): string {
  const label = CATEGORY_LABEL[o.category] ?? 'Opportunity'
  return `
              <div style="background:#fdf1e9;border:1px solid #f5d9c0;border-radius:12px;padding:16px 20px;margin-bottom:14px;">
                <p style="margin:0 0 6px;font-size:10px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:#E8650A;">${escapeHtml(label)}</p>
                <p style="margin:0 0 4px;color:#1f2817;font-size:15px;font-weight:600;line-height:22px;">${escapeHtml(o.title)}</p>
                <p style="margin:0;color:#5c5f54;font-size:13px;line-height:20px;">${escapeHtml(o.description)}</p>
              </div>`
}

export async function sendOpportunityAlertEmail(
  toEmail: string,
  userName: string,
  opportunities: { title: string; description: string; category: string }[],
): Promise<{ success: boolean }> {
  if (opportunities.length === 0) return { success: true }

  const baseUrl = process.env.NEXT_JS_URL ?? 'http://localhost:3000'
  const opportunitiesUrl = `${baseUrl}/opportunities`
  const logoUrl = process.env.EMAIL_LOGO_URL ?? `https://app.ovrt.in/favicon-light.svg`
  const count = opportunities.length
  const subject = count === 1
    ? `New opportunity: ${opportunities[0].title} — ${companyName}`
    : `${count} new opportunities for your store — ${companyName}`

  try {
    const { error } = await resend.emails.send({
      from: `Ovrt Opportunities <${process.env.EMAIL_FROM!}>`,
      to: toEmail,
      subject,
      html: `<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>New Opportunities</title>
  </head>
  <body style="margin:0;padding:0;background-color:#f6f5f0;">
    <div style="padding:48px 16px;font-family: 'Google Sans Flex', sans-serif;">
      <div style="max-width:512px;margin:0 auto;">

        <div style="text-align:center;margin-bottom:24px;">
        <img width="60" height="60" alt="${escapeHtml(companyName)}" src="${logoUrl}" style="display:inline-block;border:0;" />
        </div>

        <div style="background:#ffffff;border:1px solid #e6e4db;border-radius:16px;overflow:hidden;box-shadow:0 1px 2px rgba(31,40,23,0.04),0 8px 24px rgba(31,40,23,0.05);">
          <div style="height:4px;background:#E8650A;"></div>

          <div style="padding:44px 40px;">
            <p style="margin:0 0 12px;text-align:center;font-size:11px;font-weight:700;letter-spacing:0.16em;text-transform:uppercase;color:#E8650A;">${count === 1 ? 'New Opportunity' : 'New Opportunities'}</p>

            <h1 style="margin:0 0 26px;text-align:center;font-family:Georgia,'Times New Roman',serif;font-size:24px;line-height:1.25;color:#1f2817;font-weight:700;">
              ${count} actionable ${count === 1 ? 'idea' : 'ideas'} spotted for your store
            </h1>

            ${opportunities.map(opportunityCard).join('')}

            <div style="text-align:center;margin-top:20px;margin-bottom:34px;">
              <a href="${opportunitiesUrl}" style="display:inline-block;padding:13px 36px;border-radius:10px;background:#E8650A;color:#ffffff;text-decoration:none;font-size:14px;font-weight:600;letter-spacing:0.01em;box-shadow:0 4px 12px rgba(232,101,10,0.28);">
                View Opportunities
              </a>
            </div>

            <div style="height:1px;background:#e6e4db;margin-bottom:22px;"></div>

            <p style="margin:0;color:#a8a99d;font-size:13px;line-height:21px;text-align:center;">
              Hi ${escapeHtml(userName)}, here's what our analyst spotted in your store data.
            </p>
          </div>
        </div>

        <p style="margin:24px 0 0;text-align:center;color:#a8a99d;font-size:12px;line-height:20px;">
          © 2025 ${companyName} &nbsp;·&nbsp;
          <a href="mailto:office@hdtl.in" style="color:#E8650A;text-decoration:none;">office@hdtl.in</a>
        </p>
      </div>
    </div>
  </body>
</html>`,
    })

    if (error) {
      console.error(`[email] opportunity alert send failed to=${toEmail}:`, error)
    }

    return { success: !error }
  } catch (err) {
    console.error(`[email] opportunity alert threw to=${toEmail}:`, err)
    return { success: false }
  }
}
