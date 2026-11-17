package app.ohmydeepseek.android;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyProperties;
import android.security.keystore.KeyProtection;
import android.util.Base64;
import android.util.Log;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.util.Arrays;
import java.util.UUID;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/** AES-GCM ciphertext in private preferences; decryption keys are protected by Android Keystore. */
final class SecureKeyStore {
    private final SharedPreferences preferences;

    SecureKeyStore(Context context) {
        preferences = context.getSharedPreferences("credentials", Context.MODE_PRIVATE);
    }

    private KeyStore store() throws Exception {
        KeyStore result = KeyStore.getInstance("AndroidKeyStore");
        result.load(null);
        return result;
    }

    private byte[] decrypt(KeyStore store, String alias, byte[] iv, byte[] encrypted) throws Exception {
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, store.getKey(alias, null), new GCMParameterSpec(128, iv));
        return cipher.doFinal(encrypted);
    }

    synchronized String read() {
        String alias = preferences.getString("alias", null);
        String encrypted = preferences.getString("ciphertext", null);
        String iv = preferences.getString("iv", null);
        if (alias == null || encrypted == null || iv == null) return null;
        try {
            return new String(decrypt(store(), alias, Base64.decode(iv, Base64.NO_WRAP),
                    Base64.decode(encrypted, Base64.NO_WRAP)), StandardCharsets.UTF_8);
        } catch (Exception error) {
            Log.w("OhMyDeepSeek", "Credential decryption failed: " + error.getClass().getSimpleName());
            // A restored/unavailable device keystore requires the user to enter the key again.
            return null;
        }
    }

    synchronized boolean write(String value) {
        String previousAlias = preferences.getString("alias", null);
        if (value == null || value.isEmpty()) {
            if (!preferences.edit().clear().commit()) return false;
            deleteKey(previousAlias);
            return true;
        }
        String alias = "oh-my-deepseek-" + UUID.randomUUID();
        byte[] plain = value.getBytes(StandardCharsets.UTF_8);
        try {
            // Decryption-only imports work on virtual Keymaster implementations that
            // mishandle keys generated for multiple purposes. Never fall back to plaintext.
            KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES);
            generator.init(256);
            SecretKey key = generator.generateKey();
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, key);
            byte[] encrypted = cipher.doFinal(plain);
            byte[] iv = cipher.getIV();
            KeyStore store = store();
            store.setEntry(alias, new KeyStore.SecretKeyEntry(key), new KeyProtection.Builder(KeyProperties.PURPOSE_DECRYPT)
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build());
            byte[] roundtrip = decrypt(store, alias, iv, encrypted);
            boolean valid = Arrays.equals(plain, roundtrip);
            Arrays.fill(roundtrip, (byte) 0);
            if (!valid) throw new IllegalStateException("Credential roundtrip failed");
            boolean saved = preferences.edit().putString("alias", alias)
                    .putString("ciphertext", Base64.encodeToString(encrypted, Base64.NO_WRAP))
                .putString("iv", Base64.encodeToString(iv, Base64.NO_WRAP)).commit();
            if (!saved) { deleteKey(alias); return false; }
            deleteKey(previousAlias);
            return true;
        } catch (Exception error) {
            deleteKey(alias);
            Log.w("OhMyDeepSeek", "Credential storage failed: " + error.getClass().getSimpleName());
            return false;
        } finally { Arrays.fill(plain, (byte) 0); }
    }

    private void deleteKey(String alias) {
        if (alias == null) return;
        try { store().deleteEntry(alias); }
        catch (Exception ignored) { /* Unreferenced encryption keys contain no API key. */ }
    }
}
