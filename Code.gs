const SHEET_ID = '16-TVv6t5qNWDHEUwqzggPID8Wbp7HV96YHpnO4LGd04';
const SHEET_NAME = 'Hoja 1';

function authorize() {
  SpreadsheetApp.openById(SHEET_ID).getName();
  UrlFetchApp.fetch('https://www.youtube.com/robots.txt', { muteHttpExceptions: true });
}

function doGet(event) {
  const requestQuery = String((event && event.parameter && event.parameter.q) || '').trim();
  if (requestQuery) return searchYouTube(requestQuery);

  const sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName(SHEET_NAME);
  ensureHeaders(sheet);
  const values = sheet.getDataRange().getDisplayValues();
  return jsonResponse({ items: values.slice(1).filter(row => row[3]).map(row => ({ id: row[0], url: row[3], title: row[1] || row[0] })) });
}

function searchYouTube(query) {
  const payload = JSON.stringify({
    context: { client: { clientName: 'WEB', clientVersion: '2.20260902.01.00' } },
    query
  });
  const response = UrlFetchApp.fetch('https://www.youtube.com/youtubei/v1/search?prettyPrint=false', {
    method: 'post',
    contentType: 'application/json',
    headers: { 'User-Agent': 'Mozilla/5.0' },
    payload,
    muteHttpExceptions: true
  });
  return ContentService.createTextOutput(response.getContentText()).setMimeType(ContentService.MimeType.JSON);
}

function doPost(event) {
  if (!event || !event.postData || !event.postData.contents) {
    return jsonResponse({ ok: false, error: 'No se recibió información del video' });
  }
  let payload;
  try {
    payload = JSON.parse(event.postData.contents);
  } catch (error) {
    return jsonResponse({ ok: false, error: 'Los datos recibidos no son JSON válido' });
  }
  const submittedUrl = String(payload.url || '').trim();
  const videoId = String(payload.id || extractVideoId(submittedUrl)).trim();
  const title = String(payload.title || '').trim();
  if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) return jsonResponse({ ok: false, error: 'Falta un ID de YouTube válido' });
  const videoUrl = submittedUrl || `https://www.youtube.com/watch?v=${videoId}`;

  const sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName(SHEET_NAME);
  ensureHeaders(sheet);
  const rows = sheet.getDataRange().getDisplayValues();
  const existing = rows.slice(1).some(row => row[3] === videoUrl || extractVideoId(row[3] || row[0]) === videoId);
  if (!existing) {
    sheet.appendRow([videoUrl, title || videoId, '', videoUrl]);
    SpreadsheetApp.flush();
  }
  return jsonResponse({ ok: true, url: videoUrl, title: title || videoId });
}

function extractVideoId(value) {
  const input = String(value || '').replace('yout-ube.com', 'youtube.com');
  const match = input.match(/^.*(youtu.be\/|v\/|u\/\w\/|embed\/|watch\?v=|\&v=)([^#\&\?]*).*/);
  return match && match[2].length === 11 ? match[2] : input;
}

function ensureHeaders(sheet) {
  if (sheet.getRange('A1').getValue() !== 'id') sheet.getRange('A1').setValue('id');
  if (sheet.getRange('B1').getValue() !== 'tema/cancion') sheet.getRange('B1').setValue('tema/cancion');
  if (sheet.getRange('D1').getValue() !== 'enlace') sheet.getRange('D1').setValue('enlace');
}

function jsonResponse(data) {
  return ContentService.createTextOutput(JSON.stringify(data)).setMimeType(ContentService.MimeType.JSON);
}
