import { useState } from 'react';
import { Star, Play } from 'lucide-react';

export interface VideoCardProps {
  title: string;
  coverUrl?: string | null;
  author?: string;
  subLabel?: string;
  badgeText?: string;
  badgeTone?: 'boom' | 'top' | 'rank' | 'muted';
  playLabel?: string;
  rightMetricLabel?: string;
  starred?: boolean;
  onClick: () => void;
  onToggleStar?: (ev: React.MouseEvent) => void;
}

const FALLBACK_GRADIENTS = [
  'linear-gradient(135deg, #1e1b4b 0%, #3730a3 55%, #0284c7 100%)',
  'linear-gradient(135deg, #451a03 0%, #c2410c 55%, #f59e0b 100%)',
  'linear-gradient(135deg, #064e3b 0%, #0d9488 55%, #38bdf8 100%)',
  'linear-gradient(135deg, #4c1d95 0%, #7c3aed 55%, #ec4899 100%)',
];

function normalizeCoverUrl(raw?: string | null): string {
  if (!raw) return '';
  const trimmed = raw.trim();
  if (!trimmed) return '';
  if (trimmed.startsWith('//')) return `https:${trimmed}`;
  if (trimmed.startsWith('http://')) return `https://${trimmed.slice(7)}`;
  return trimmed;
}

export function VideoCard({
  title,
  coverUrl,
  author,
  subLabel,
  badgeText,
  badgeTone = 'rank',
  playLabel,
  rightMetricLabel,
  starred,
  onClick,
  onToggleStar,
}: VideoCardProps) {
  const [imgFailed, setImgFailed] = useState(false);
  const safeSrc = normalizeCoverUrl(coverUrl);
  const showImg = Boolean(safeSrc) && !imgFailed;
  const fallbackBg = FALLBACK_GRADIENTS[Math.abs(title.length) % FALLBACK_GRADIENTS.length];

  return (
    <article className="vcard" onClick={onClick}>
      <div className="vcard-media" style={!showImg ? { background: fallbackBg } : undefined}>
        {showImg ? (
          <img
            src={safeSrc}
            alt={title}
            referrerPolicy="no-referrer"
            loading="lazy"
            className="vcard-img"
            onError={() => setImgFailed(true)}
          />
        ) : (
          <div className="vcard-fallback-text">{subLabel || '视频作品'}</div>
        )}

        {/* 顶部与底部柔和暗角遮罩，保证亮色封面上的文字始终清晰 */}
        <div className="vcard-scrim" />

        <div className="vcard-top-row">
          {badgeText ? (
            <span className={`vcard-badge vcard-badge-${badgeTone}`}>{badgeText}</span>
          ) : (
            <span />
          )}
          {onToggleStar && (
            <button
              type="button"
              className={`vcard-star ${starred ? 'active' : ''}`}
              onClick={onToggleStar}
              title={starred ? '取消收藏' : '收藏到本子'}
              aria-label={starred ? '取消收藏' : '收藏'}
            >
              <Star size={13} fill={starred ? 'currentColor' : 'none'} />
            </button>
          )}
        </div>

        {(playLabel || rightMetricLabel) && (
          <div className="vcard-bottom-row">
            {playLabel ? (
              <span className="vcard-pill">
                <Play size={10} fill="currentColor" /> {playLabel}
              </span>
            ) : (
              <span />
            )}
            {rightMetricLabel ? <span className="vcard-pill">{rightMetricLabel}</span> : null}
          </div>
        )}
      </div>

      <div className="vcard-body">
        <div className="vcard-title" title={title}>
          {title}
        </div>
        <div className="vcard-foot">
          <span className="vcard-author">{author || '—'}</span>
          {subLabel ? <span className="vcard-cat">{subLabel}</span> : null}
        </div>
      </div>
    </article>
  );
}
