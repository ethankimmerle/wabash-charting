// The Apps Script web app. On localhost the app uses the test server's /api instead,
// so running the tests can never touch the real Google Sheet.
const SHEET_URL = 'https://script.google.com/macros/s/AKfycbw_mRMT7VQmyb7UobdgQ60xBT5Cvkk1rNby7OIj9VZ0oNo2FUP83B97G5GfPamT8644aA/exec';
export const API_URL = location.hostname === 'localhost' ? '' : SHEET_URL;
