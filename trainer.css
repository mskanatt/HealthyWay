/* ============ Тренер по технике (вкладка "Техника") ============ */

.trainer-controls{
  display:flex;
  align-items:flex-end;
  flex-wrap: wrap;
  gap: 14px;
  margin-bottom: 14px;
}
.trainer-controls label{
  display:flex;
  flex-direction:column;
  gap: 5px;
  font-size: 0.8rem;
  color: var(--ink-dim);
}
.trainer-controls select{
  background: var(--panel-2);
  border: 1px solid var(--line);
  color: var(--ink);
  border-radius: 8px;
  padding: 10px 12px;
  font-family: var(--font-body);
  font-size: 0.92rem;
}
.trainer-controls select:focus{ outline:none; border-color: var(--green-dim); }
.trainer-controls .trainer-check{
  flex-direction: row;
  align-items: center;
  gap: 8px;
  font-size: 0.88rem;
  padding-bottom: 10px;
}

.trainer-stage{
  position: relative;
  max-width: 720px;
  min-height: 280px;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--panel);
  overflow: hidden;
}
.trainer-stage video{
  display:block;
  width: 100%;
  height: auto;
}
.trainer-stage canvas{
  position:absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
}
/* Фронтальная камера отображается как зеркало; видео и скелет отзеркаливаются вместе. */
.trainer-stage.mirrored video,
.trainer-stage.mirrored canvas{ transform: scaleX(-1); }

.trainer-placeholder{
  position:absolute;
  inset: 0;
  display:flex;
  flex-direction:column;
  align-items:center;
  justify-content:center;
  gap: 8px;
  padding: 24px;
  text-align:center;
  color: var(--ink-dim);
  font-size: 0.92rem;
}
.trainer-placeholder svg{ color: var(--green); }
.trainer-placeholder p{ margin: 0; max-width: 34ch; }

.trainer-hud{
  position:absolute;
  top: 12px; left: 12px; right: 12px;
  display:flex;
  justify-content: space-between;
  pointer-events:none;
}
.trainer-reps, .trainer-angle{
  background: rgba(11,15,13,0.72);
  backdrop-filter: blur(6px);
  border: 1px solid var(--line);
  border-radius: 12px;
  padding: 8px 14px;
  display:flex;
  flex-direction:column;
  align-items:center;
  line-height: 1.1;
}
.trainer-reps span, .trainer-angle span{
  font-family: var(--font-display);
  font-size: 1.7rem;
  font-weight: 600;
  color: var(--green);
}
.trainer-angle span{ color: var(--ink); }
.trainer-reps small, .trainer-angle small{
  font-size: 0.7rem;
  color: var(--ink-dim);
  margin-top: 3px;
}

.trainer-cue{
  position:absolute;
  left: 50%;
  bottom: 18px;
  transform: translateX(-50%);
  padding: 10px 20px;
  border-radius: 100px;
  font-family: var(--font-display);
  font-weight: 600;
  font-size: 1.05rem;
  white-space: nowrap;
  pointer-events:none;
}
.trainer-cue-ok{ background: var(--green); color: #0b0f0d; }
.trainer-cue-warn{ background: var(--amber); color: #0b0f0d; }

.trainer-buttons{
  display:flex;
  flex-wrap: wrap;
  gap: 10px;
  margin: 14px 0 6px;
}
.trainer-status{
  min-height: 1.4em;
  margin: 6px 0 14px;
  font-size: 0.88rem;
  color: var(--ink-dim);
}
.trainer-status[data-kind="warn"]{ color: var(--amber); }
.trainer-status[data-kind="error"]{ color: var(--red); }
.trainer-status[data-kind="ok"]{ color: var(--green); }

.trainer-summary{
  max-width: 720px;
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  padding: 18px;
  margin-bottom: 18px;
}
.trainer-summary h3{
  font-family: var(--font-display);
  font-size: 1.05rem;
  margin: 0 0 8px;
  color: var(--green);
}
.trainer-summary-text{
  margin: 0 0 12px;
  font-size: 0.92rem;
  color: var(--ink);
}
.trainer-ai-text{
  margin: 12px 0 0;
  font-size: 0.9rem;
  color: var(--ink-dim);
  white-space: pre-wrap;
}

.trainer-history{ max-width: 720px; margin-bottom: 18px; }
.trainer-history-title{
  font-family: var(--font-display);
  font-size: 0.85rem;
  color: var(--ink-dim);
  margin: 0 0 10px;
}
.trainer-history-row{
  display:flex;
  justify-content: space-between;
  gap: 12px;
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 12px;
  padding: 10px 14px;
  margin-bottom: 8px;
  font-size: 0.9rem;
}
.trainer-history-date{ color: var(--ink-dim); font-size: 0.8rem; white-space: nowrap; }

.trainer-tips{
  max-width: 720px;
  margin: 0 0 16px;
  padding-left: 18px;
  font-size: 0.86rem;
  color: var(--ink-dim);
}
.trainer-tips li{ margin-bottom: 4px; }

/* 6 кнопок в нижней навигации на узких экранах */
@media (max-width: 420px){
  .bottom-nav-btn{ padding: 6px 5px; font-size: 0.62rem; }
}
