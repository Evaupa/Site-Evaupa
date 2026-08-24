export const DRIVE_APPDATA_SCOPE = 'https://www.googleapis.com/auth/drive.appdata';
export const DRIVE_BACKUP_NAME = 'omnihome-backup.json';

export function classifyAdditionalUserInfo(additional) {
    if (additional === null || typeof additional?.isNewUser !== 'boolean') return 'unknown';
    return additional.isNewUser ? 'new' : 'existing';
}

export function assertSameUid(expectedUid, actualUid) {
    if (!expectedUid || !actualUid || expectedUid !== actualUid) {
        throw Object.assign(new Error('Authenticated user mismatch'), { code: 'auth/user-mismatch' });
    }
}

function driveError(code, message) { return Object.assign(new Error(message), { code }); }

export async function deleteOmniHomeDriveBackup(accessToken, fetchImpl = fetch) {
    if (!accessToken) throw driveError('drive/authorization-failed', 'Missing in-memory access token');
    const params = new URLSearchParams({
        spaces: 'appDataFolder',
        q: `name='${DRIVE_BACKUP_NAME}' and trashed=false`,
        pageSize: '2',
        fields: 'files(id,name,modifiedTime)'
    });
    const headers = { Authorization: `Bearer ${accessToken}` };
    const listResponse = await fetchImpl(`https://www.googleapis.com/drive/v3/files?${params}`, { headers });
    if (!listResponse.ok) throw driveError('drive/list-failed', 'Drive list request failed');
    const payload = await listResponse.json();
    const files = Array.isArray(payload?.files) ? payload.files : [];
    if (files.length === 0) return { state: 'not_found' };
    if (files.length > 1) throw driveError('drive/ambiguous-backup', 'More than one OmniHome backup was found');
    const file = files[0];
    if (!file?.id || file.name !== DRIVE_BACKUP_NAME) throw driveError('drive/invalid-response', 'Drive returned an unexpected file');
    const deleteResponse = await fetchImpl(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(file.id)}`, { method: 'DELETE', headers });
    if (!deleteResponse.ok) throw driveError('drive/delete-failed', 'Drive delete request failed');
    return { state: 'deleted' };
}

export async function cleanupAccidentalIdentity({ user, deleteUser, signOut }) {
    let deleted = false;
    let signedOut = false;
    try { await deleteUser(user); deleted = true; } catch { deleted = false; }
    finally { try { await signOut(); signedOut = true; } catch { signedOut = false; } }
    return { deleted, signedOut };
}
