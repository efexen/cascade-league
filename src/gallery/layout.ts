export const GALLERY_LAYOUT_CSS = `/* Cascade League-owned result-card geometry. Champion CSS still owns the visual language. */
.leaderboard-grid {
  grid-template-columns: minmax(0, 1fr) !important;
  gap: 42px !important;
}

.entry-card {
  position: relative !important;
  display: grid !important;
  grid-template-columns: 1.5fr 1fr minmax(190px, 0.8fr) 150px !important;
  grid-template-areas:
    "visual visual visual visual"
    "head scores award link" !important;
  height: auto !important;
}

.entry-visual {
  position: relative !important;
  grid-area: visual !important;
  width: 100% !important;
  height: auto !important;
  aspect-ratio: 16 / 15 !important;
  border-top: 0 !important;
}

.entry-caption {
  position: absolute !important;
  z-index: 2 !important;
  right: auto !important;
  bottom: 12px !important;
  left: 12px !important;
  display: block !important;
  width: auto !important;
  height: auto !important;
  opacity: 1 !important;
  visibility: visible !important;
  overflow: visible !important;
}

.entry-thumbnail {
  width: 100% !important;
  height: 100% !important;
  object-fit: contain !important;
  object-position: top !important;
}

.entry-header {
  grid-area: head !important;
  align-self: stretch !important;
  padding: 11px 16px 9px !important;
}

.entry-rank {
  margin: 0 0 5px !important;
}

.entry-title {
  font-size: 22px !important;
  line-height: 1 !important;
}

.entry-identity {
  margin-top: 6px !important;
}

.entry-card::before {
  position: absolute !important;
  z-index: 2 !important;
  top: 14px !important;
  right: 14px !important;
  display: flex !important;
  align-items: center !important;
  justify-content: center !important;
  width: 72px !important;
  height: 72px !important;
  border: 3px solid currentColor !important;
  font-size: 52px !important;
}

.entry[data-rank="1"] .entry-card::before { content: "1" !important; }
.entry[data-rank="2"] .entry-card::before { content: "2" !important; }
.entry[data-rank="3"] .entry-card::before { content: "3" !important; }
.entry[data-rank="4"] .entry-card::before { content: "4" !important; }
.entry[data-rank="5"] .entry-card::before { content: "5" !important; }
.entry[data-rank="6"] .entry-card::before { content: "6" !important; }

.entry-scores {
  grid-area: scores !important;
  display: grid !important;
  grid-template-columns: repeat(2, minmax(0, 1fr)) !important;
  margin: 0 !important;
  border-top: 2px solid currentColor !important;
  border-left: 2px solid currentColor !important;
}

.entry-scores > div {
  padding: 9px 14px !important;
}

.entry-scores dd {
  font-size: 25px !important;
}

.entry-awards {
  grid-area: award !important;
  align-self: stretch !important;
  min-height: 0 !important;
  margin: 0 !important;
  padding: 9px 12px !important;
  border-top: 2px solid currentColor !important;
  border-left: 2px solid currentColor !important;
}

.entry-detail-link {
  grid-area: link !important;
  align-self: stretch !important;
  display: flex !important;
  align-items: center !important;
  justify-content: center !important;
  padding: 8px 12px !important;
}

@media (max-width: 760px) {
  .entry-card {
    grid-template-columns: minmax(0, 1fr) 130px !important;
    grid-template-areas:
      "visual visual"
      "head head"
      "scores link"
      "award award" !important;
  }

  .entry-card::before {
    width: 54px !important;
    height: 54px !important;
    font-size: 38px !important;
  }
}
`;
