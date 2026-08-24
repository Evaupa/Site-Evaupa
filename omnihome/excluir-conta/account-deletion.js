import { DRIVE_APPDATA_SCOPE, assertSameUid, classifyAdditionalUserInfo, cleanupAccidentalIdentity, deleteOmniHomeDriveBackup } from './account-deletion-core.js';

const FIREBASE_VERSION = '12.17.1';
const config = window.OMNIHOME_FIREBASE_CONFIG;
const elements = {
    setupNotice: document.querySelector('#setup-notice'), status: document.querySelector('#status'), signIn: document.querySelector('#google-sign-in'),
    signedOutActions: document.querySelector('#signed-out-actions'), signedInArea: document.querySelector('#signed-in-area'), accountLabel: document.querySelector('#account-label'),
    deleteDrive: document.querySelector('#delete-drive-backup'), understand: document.querySelector('#understand-deletion'), openConfirmation: document.querySelector('#open-delete-confirmation'),
    signOut: document.querySelector('#sign-out'), dialog: document.querySelector('#delete-dialog'), phrase: document.querySelector('#delete-phrase'), confirmDelete: document.querySelector('#confirm-delete'),
    driveSummary: document.querySelector('#drive-confirmation-summary'), driveFailureDialog: document.querySelector('#drive-failure-dialog'),
    driveFailureMessage: document.querySelector('#drive-failure-message'), retryDrive: document.querySelector('#retry-drive-delete'),
    continueWithoutDrive: document.querySelector('#continue-preserving-drive'), cancelDriveFailure: document.querySelector('#cancel-drive-failure')
};

let auth;
let authApi;
let expectedUid = null;
let pendingAccidentalUid = null;
let busy = false;
let drivePreservedByChoice = false;

function createProvider(includeDrive = false) {
    const provider = new authApi.GoogleAuthProvider();
    provider.setCustomParameters({ prompt: 'select_account' });
    if (includeDrive) provider.addScope(DRIVE_APPDATA_SCOPE);
    return provider;
}

function setStatus(message, type = '') {
    elements.status.textContent = message;
    elements.status.className = `status${type ? ` ${type}` : ''}`;
}

function setBusy(value) {
    busy = value;
    elements.signIn.disabled = value || !config;
    elements.signOut.disabled = value;
    elements.deleteDrive.disabled = value;
    elements.openConfirmation.disabled = value || !elements.understand.checked;
    elements.confirmDelete.disabled = value || elements.phrase.value.trim() !== 'EXCLUIR';
    elements.retryDrive.disabled = value;
    elements.continueWithoutDrive.disabled = value;
    elements.cancelDriveFailure.disabled = value;
}

function resetDeletionChoices() {
    elements.understand.checked = false;
    elements.deleteDrive.checked = false;
    elements.phrase.value = '';
    drivePreservedByChoice = false;
}

function showSignedOut({ preservePendingAccidental = true } = {}) {
    expectedUid = null;
    if (!preservePendingAccidental) pendingAccidentalUid = null;
    elements.signedOutActions.hidden = false;
    elements.signedInArea.hidden = true;
    elements.accountLabel.textContent = '';
    resetDeletionChoices();
    setBusy(false);
}

function showSignedIn(user) {
    expectedUid = user.uid;
    pendingAccidentalUid = null;
    elements.signedOutActions.hidden = true;
    elements.signedInArea.hidden = false;
    elements.accountLabel.textContent = user.displayName || user.email || 'Conta Google confirmada';
    setStatus('Identidade preexistente confirmada. Leia as consequências antes de continuar.', 'success');
    setBusy(false);
}

function controlledError(error) {
    const code = typeof error?.code === 'string' ? error.code : '';
    if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request') return 'A autenticação foi cancelada.';
    if (code === 'auth/popup-blocked') return 'O navegador bloqueou a janela do Google. Permita pop-ups e tente novamente.';
    if (code === 'auth/network-request-failed') return 'Não foi possível acessar o Google. Verifique sua conexão e tente novamente.';
    if (code === 'auth/requires-recent-login') return 'Por segurança, autentique-se novamente antes de excluir.';
    if (code === 'auth/user-mismatch') return 'A conta escolhida é diferente da conta OmniHome autenticada.';
    if (code === 'drive/ambiguous-backup') return 'Foram encontrados vários backups com o mesmo nome. Nenhum arquivo foi excluído automaticamente.';
    if (code.startsWith('drive/')) return 'Não foi possível autorizar, localizar ou excluir o backup do OmniHome no Google Drive.';
    return 'Não foi possível concluir a operação com segurança. Tente novamente mais tarde.';
}

async function loadFirebase() {
    const [{ initializeApp }, authModule] = await Promise.all([
        import(`https://www.gstatic.com/firebasejs/${FIREBASE_VERSION}/firebase-app.js`),
        import(`https://www.gstatic.com/firebasejs/${FIREBASE_VERSION}/firebase-auth.js`)
    ]);
    authApi = authModule;
    auth = authApi.getAuth(initializeApp(config));
    await authApi.setPersistence(auth, authApi.inMemoryPersistence);
}

async function cleanNewIdentity(user) {
    pendingAccidentalUid = user.uid;
    const result = await cleanupAccidentalIdentity({ user, deleteUser: authApi.deleteUser, signOut: () => authApi.signOut(auth) });
    showSignedOut({ preservePendingAccidental: !result.deleted });
    if (result.deleted) {
        pendingAccidentalUid = null;
        setStatus('Esta Conta Google não possuía uma conta OmniHome anterior. A identidade temporária criada pelo login foi removida e a sessão foi encerrada.', 'success');
    } else {
        setStatus('A identidade temporária criada pelo login não pôde ser removida com segurança. A exclusão normal foi bloqueada. Tente entrar novamente para repetir a limpeza.', 'error');
    }
    if (!result.signedOut) setStatus('A limpeza não pôde ser confirmada e a sessão não foi encerrada corretamente. Feche esta página antes de tentar novamente.', 'error');
}

async function signIn() {
    setBusy(true);
    setStatus('Abrindo a autenticação segura do Google…');
    try {
        if (!auth) await loadFirebase();
        const result = await authApi.signInWithPopup(auth, createProvider(false));
        const classification = classifyAdditionalUserInfo(authApi.getAdditionalUserInfo(result));
        if (pendingAccidentalUid === result.user.uid || classification === 'new') { await cleanNewIdentity(result.user); return; }
        if (classification !== 'existing') {
            try { await authApi.signOut(auth); } finally { showSignedOut(); }
            setStatus('O Firebase não confirmou se esta identidade OmniHome já existia. A exclusão foi bloqueada e a sessão encerrada. Tente novamente.', 'error');
            return;
        }
        showSignedIn(result.user);
    } catch (error) {
        showSignedOut();
        setStatus(controlledError(error), 'error');
    } finally { setBusy(false); }
}

async function signOutWithoutDeleting() {
    setBusy(true);
    try {
        if (auth) await authApi.signOut(auth);
        showSignedOut();
        setStatus('Sessão encerrada. Nenhuma conta foi excluída.');
    } catch { setStatus('Não foi possível encerrar a sessão agora. Feche esta página e tente novamente.', 'error'); }
    finally { setBusy(false); }
}

async function deleteDriveBackup(user) {
    let accessToken = null;
    try {
        setStatus('Solicitando autorização exclusiva para o backup privado do OmniHome…');
        const result = await authApi.reauthenticateWithPopup(user, createProvider(true));
        assertSameUid(expectedUid, result.user.uid);
        accessToken = authApi.GoogleAuthProvider.credentialFromResult(result)?.accessToken || null;
        return await deleteOmniHomeDriveBackup(accessToken);
    } finally { accessToken = null; }
}

async function deleteDriveBackupFromReauthentication(result) {
    let accessToken = null;
    try {
        accessToken = authApi.GoogleAuthProvider.credentialFromResult(result)?.accessToken || null;
        return await deleteOmniHomeDriveBackup(accessToken);
    } finally { accessToken = null; }
}

async function finalizeFirebaseDeletion(user, driveState) {
    await authApi.deleteUser(user);
    await authApi.signOut(auth);
    if (elements.dialog.open) elements.dialog.close();
    if (elements.driveFailureDialog.open) elements.driveFailureDialog.close();
    showSignedOut();
    const driveMessage = driveState === 'deleted' ? ' O backup privado do OmniHome também foi excluído.'
        : driveState === 'not_found' ? ' Nenhum backup privado do OmniHome foi encontrado no Drive.'
            : driveState === 'preserved' ? ' O backup do Drive foi preservado por sua escolha.' : ' O Google Drive não foi acessado.';
    setStatus(`Conta OmniHome excluída com sucesso.${driveMessage} Sua Conta Google, Gmail e assinatura Google Play não foram alterados.`, 'success');
}

function showDriveFailure(error) {
    if (elements.dialog.open) elements.dialog.close();
    elements.driveFailureMessage.textContent = `${controlledError(error)} A conta Firebase ainda não foi excluída.`;
    elements.driveFailureDialog.showModal();
    setStatus('A exclusão da conta foi pausada porque o backup Drive não pôde ser tratado.', 'error');
}

async function deleteAccount() {
    const user = auth?.currentUser;
    if (!user || !expectedUid || user.uid !== expectedUid) {
        if (elements.dialog.open) elements.dialog.close();
        showSignedOut();
        setStatus('A sessão não pôde ser confirmada. Entre novamente com Google.', 'error');
        return;
    }
    setBusy(true);
    try {
        const wantsDriveDeletion = elements.deleteDrive.checked && !drivePreservedByChoice;
        setStatus(wantsDriveDeletion
            ? 'Aguardando reautenticação e autorização exclusiva do backup privado do OmniHome…'
            : 'Aguardando reautenticação do Google…');
        const reauthResult = await authApi.reauthenticateWithPopup(user, createProvider(wantsDriveDeletion));
        assertSameUid(expectedUid, reauthResult.user.uid);
        let driveState = 'not_requested';
        if (wantsDriveDeletion) {
            try { driveState = (await deleteDriveBackupFromReauthentication(reauthResult)).state; }
            catch (error) { showDriveFailure(error); return; }
        } else if (drivePreservedByChoice) driveState = 'preserved';
        await finalizeFirebaseDeletion(reauthResult.user, driveState);
    } catch (error) {
        if (elements.dialog.open) elements.dialog.close();
        setStatus(controlledError(error), 'error');
    } finally { setBusy(false); }
}

async function retryDriveDeletion() {
    const user = auth?.currentUser;
    if (!user || user.uid !== expectedUid) { showSignedOut(); return; }
    setBusy(true);
    try { await finalizeFirebaseDeletion(user, (await deleteDriveBackup(user)).state); }
    catch (error) {
        elements.driveFailureMessage.textContent = `${controlledError(error)} A conta Firebase ainda não foi excluída.`;
        setStatus('A nova tentativa falhou. Nenhuma conta Firebase foi excluída.', 'error');
    } finally { setBusy(false); }
}

elements.understand.addEventListener('change', () => setBusy(busy));
elements.phrase.addEventListener('input', () => setBusy(busy));
elements.openConfirmation.addEventListener('click', () => {
    elements.phrase.value = '';
    drivePreservedByChoice = false;
    elements.driveSummary.textContent = elements.deleteDrive.checked
        ? 'Você escolheu excluir também o backup privado do OmniHome. O acesso incremental ao appDataFolder será solicitado na mesma janela de reautenticação.'
        : 'Você escolheu preservar o backup do Google Drive. Nenhum escopo do Drive será solicitado.';
    setBusy(false);
    elements.dialog.showModal();
    elements.phrase.focus();
});
elements.signIn.addEventListener('click', signIn);
elements.signOut.addEventListener('click', signOutWithoutDeleting);
elements.confirmDelete.addEventListener('click', deleteAccount);
elements.retryDrive.addEventListener('click', retryDriveDeletion);
elements.cancelDriveFailure.addEventListener('click', () => {
    elements.driveFailureDialog.close();
    setStatus('Exclusão cancelada. A conta Firebase e o backup Drive foram preservados.');
});
elements.continueWithoutDrive.addEventListener('click', () => {
    drivePreservedByChoice = true;
    elements.driveFailureDialog.close();
    elements.phrase.value = '';
    elements.driveSummary.textContent = 'Você escolheu continuar preservando o backup do Drive após a falha. Digite EXCLUIR novamente para confirmar conscientemente essa decisão.';
    setBusy(false);
    elements.dialog.showModal();
    elements.phrase.focus();
});

if (!config) {
    elements.setupNotice.hidden = false;
    elements.signIn.disabled = true;
    setStatus('Fluxo preparado localmente; autenticação indisponível até a configuração pública do Firebase Web.', 'error');
} else {
    elements.setupNotice.hidden = true;
    setBusy(false);
}
