import { studioTheme } from 'ag-studio';

const carbon = '#1f2a7a';
const carbonSoft = '#4a5393';
const bond = '#f6f7f9';
const rule = '#b9beda';
const franklin = 'var(--font-franklin)';

// AG Studio dressed as the white sheet of the carbon form: square corners, pale blue rules, blue ink.
export const formTheme = studioTheme.withParams({
  backgroundColor: bond,
  foregroundColor: carbon,
  accentColor: carbon,
  borderColor: rule,
  borderRadius: 0,
  fontFamily: franklin,

  studioCanvasBackgroundColor: bond,
  studioCanvasFontFamily: franklin,
  studioWidgetBackgroundColor: bond,
  studioWidgetBorderRadius: 0,
  studioWidgetTitleFontFamily: franklin,
  studioWidgetTitleTextColor: carbon,
  studioWidgetTitleFontSize: 15,
  studioWidgetTitleFontWeight: 700,
  studioWidgetSubtitleFontFamily: franklin,
  studioWidgetSubtitleTextColor: carbonSoft,

  gridFontFamily: franklin,
  gridHeaderFontFamily: franklin,
  gridCellFontFamily: franklin,

  chartFontFamily: franklin,
  chartPaletteFills1Color: carbon,
  chartPaletteFills2Color: '#d3122f',
  chartPaletteFills3Color: '#b9beda',
});
