import { Resend } from 'resend'

const resend = new Resend(process.env.RESEND_API_KEY)
const companyName = process.env.COMPANY_NAME ?? 'Ovrt'

function healthColor(score: number): string {
  if (score >= 70) return '#E8650A'
  if (score >= 50) return '#b7861f'
  if (score >= 30) return '#c2620e'
  return '#b91c1c'
}

function healthLabel(score: number): string {
  if (score >= 70) return 'Healthy'
  if (score >= 50) return 'Watch'
  if (score >= 30) return 'Concerning'
  return 'Critical'
}

function bulletList(items: string[]): string {
  return items
    .map(
      (item) =>
        `<li style="margin:0 0 8px;color:#5c5f54;font-size:14px;line-height:22px;padding-left:4px;">${escapeHtml(item)}</li>`,
    )
    .join('')
}

// Minimal HTML-escape so LLM-authored strings can't break the markup.
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

// Renders a signed WoW percentage, or "—" when there is no prior-week baseline.
function fmtWow(pct: number | null): string {
  if (pct === null || pct === undefined) return '—'
  return (pct >= 0 ? '+' : '') + pct.toFixed(1) + '%'
}

export async function sendWeeklyDigestEmail(
  toEmail: string,
  userName: string,
  digest: {
    weekStart: string
    weekEnd: string
    headline: string
    healthScore: number
    topWins: string[]
    topConcerns: string[]
    currency?: string
    totalRevenue?: number
    revenueChangePct?: number | null
    topOpportunity?: { title: string; summary: string } | null
  },
): Promise<{ success: boolean }> {
  const baseUrl = process.env.NEXT_JS_URL ?? 'http://localhost:3000'
  const digestUrl = `${baseUrl}/digest`
  const logoUrl =
    process.env.EMAIL_LOGO_URL ?? `${baseUrl}/favicon-light.svg`
  const color = healthColor(digest.healthScore)
  const label = healthLabel(digest.healthScore)

  // Revenue snapshot line — only rendered when revenue data is supplied.
  const revenueBlock =
    digest.totalRevenue !== undefined
      ? `
            <!-- Revenue snapshot -->
            <div style="text-align:center;margin-bottom:26px;">
              <p style="margin:0 0 2px;font-size:11px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;color:#9a9c8f;">Revenue this week</p>
              <p style="margin:0;font-family:Georgia,'Times New Roman',serif;font-size:24px;color:#1f2817;font-weight:700;">
                ${escapeHtml(digest.currency ?? '')} ${digest.totalRevenue.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                <span style="font-size:14px;font-weight:600;color:${(digest.revenueChangePct ?? 0) >= 0 ? '#E8650A' : '#b91c1c'};">${fmtWow(digest.revenueChangePct ?? null)} WoW</span>
              </p>
            </div>`
      : ''

  // Top opportunity callout — only rendered when one is supplied.
  const opportunityBlock = digest.topOpportunity
    ? `
            <!-- Top opportunity -->
            <div style="margin-bottom:34px;">
              <p style="margin:0 0 10px;font-size:11px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;color:#E8650A;">Top Opportunity</p>
              <div style="background:#fdf1e9;border:1px solid #f5d9c0;border-radius:12px;padding:16px 20px;">
                <p style="margin:0 0 4px;color:#1f2817;font-size:15px;font-weight:600;line-height:22px;">${escapeHtml(digest.topOpportunity.title)}</p>
                <p style="margin:0;color:#5c5f54;font-size:13px;line-height:20px;">${escapeHtml(digest.topOpportunity.summary)}</p>
              </div>
            </div>`
    : ''

  try {
    const { error } = await resend.emails.send({
      from: `Ovrt Weekly Digest  <${process.env.EMAIL_FROM!}>`,
      to: toEmail,
      subject: `Weekly digest: ${digest.weekStart} – ${digest.weekEnd} — ${companyName}`,
      html: `<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>Weekly Digest</title>
  </head>
  <body style="margin:0;padding:0;background-color:#f6f5f0;font-family: 'Google Sans Flex', sans-serif;">
    <div style="padding:48px 16px;font-family: 'Google Sans Flex', sans-serif;">
      <div style="max-width:512px;margin:0 auto;">

        <!-- Wordmark -->
        <div style="text-align:center;margin-bottom:24px;">
        <img width="60" height="60" alt="${escapeHtml(companyName)}" src="${logoUrl}" style="display:inline-block;border:0;" />
        </div>

        <!-- Card -->
        <div style="background:#ffffff;border:1px solid #e6e4db;border-radius:16px;overflow:hidden;box-shadow:0 1px 2px rgba(31,40,23,0.04),0 8px 24px rgba(31,40,23,0.05);">
          <!-- Top accent bar -->
          <div style="height:4px;background:#E8650A;"></div>

          <div style="padding:44px 40px;">
            <!-- Eyebrow -->
            <p style="margin:0 0 12px;text-align:center;font-size:11px;font-weight:700;letter-spacing:0.16em;text-transform:uppercase;color:#E8650A;">Weekly Digest</p>

            <!-- Heading + date range -->
            <h1 style="margin:0 0 6px;text-align:center;font-family:Georgia,'Times New Roman',serif;font-size:26px;line-height:1.25;color:#1f2817;font-weight:700;">
              Your week in review
            </h1>
            <p style="margin:0 0 26px;text-align:center;color:#9a9c8f;font-size:13px;letter-spacing:0.04em;">
              ${digest.weekStart} &nbsp;–&nbsp; ${digest.weekEnd}
            </p>

            <!-- Health score badge -->
            <div style="text-align:center;margin-bottom:26px;">
              <span style="display:inline-block;padding:7px 20px;border-radius:99px;background:${color}14;border:1px solid ${color}40;color:${color};font-size:13px;font-weight:600;letter-spacing:0.03em;">
                Store Health: ${label} · ${digest.healthScore}/100
              </span>
            </div>

            <!-- Headline insight -->
            <div style="background:#fdf1e9;border:1px solid #f5d9c0;border-radius:12px;padding:20px 22px;margin-bottom:32px;">
              <p style="margin:0;color:#3f4438;font-size:15px;line-height:26px;text-align:center;font-family:Georgia,'Times New Roman',serif;font-style:italic;">
                “${escapeHtml(digest.headline)}”
              </p>
            </div>
${revenueBlock}

            <!-- Top Wins -->
            <div style="margin-bottom:20px;">
              <p style="margin:0 0 10px;font-size:11px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;color:#E8650A;">Top Wins</p>
              <div style="background:#f3f7ec;border:1px solid #dde7cc;border-radius:12px;padding:16px 20px;">
                <ul style="margin:0;padding-left:16px;">
                  ${bulletList(digest.topWins)}
                </ul>
              </div>
            </div>

            <!-- Watch Out -->
            <div style="margin-bottom:34px;">
              <p style="margin:0 0 10px;font-size:11px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;color:#b91c1c;">Watch Out</p>
              <div style="background:#fbf2f1;border:1px solid #f0d9d6;border-radius:12px;padding:16px 20px;">
                <ul style="margin:0;padding-left:16px;">
                  ${bulletList(digest.topConcerns)}
                </ul>
              </div>
            </div>
${opportunityBlock}

            <!-- CTA -->
            <div style="text-align:center;margin-bottom:34px;">
              <a href="${digestUrl}" style="display:inline-block;padding:13px 36px;border-radius:10px;background:#E8650A;color:#ffffff;text-decoration:none;font-size:14px;font-weight:600;letter-spacing:0.01em;box-shadow:0 4px 12px rgba(232,101,10,0.28);">
                Read Full Digest
              </a>
            </div>

            <!-- Divider -->
            <div style="height:1px;background:#e6e4db;margin-bottom:22px;"></div>

            <!-- Greeting footer -->
            <p style="margin:0;color:#a8a99d;font-size:13px;line-height:21px;text-align:center;">
              Hi ${escapeHtml(userName)}, here's your weekly store summary from ${escapeHtml(companyName)}.
            </p>
          </div>
        </div>

        <!-- Footer -->
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
      console.error(`[email] weekly digest send failed to=${toEmail}:`, error)
    }

    return { success: !error }
  } catch (err) {
    console.error(`[email] weekly digest threw to=${toEmail}:`, err)
    return { success: false }
  }
}
