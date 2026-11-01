import React, { useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { getApiUrl, setApiUrl } from '../api/client';
import { DEMO_RESIDENTS, useAuth } from '../context/AuthContext';
import { colors } from '../styles/theme';

export function LoginScreen() {
  const { login, demoLogin, error: authError } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [apiUrl, setLocalApiUrl] = useState(getApiUrl());
  const [showConfig, setShowConfig] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  const handleLogin = async (loginEmail = email, loginPass = password) => {
    setLocalError(null);
    if (!loginEmail.trim() || !loginPass) {
      setLocalError('Please enter both email and password.');
      return;
    }

    setLoading(true);
    try {
      setApiUrl(apiUrl.trim());
      await login(loginEmail.trim(), loginPass);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Invalid credentials or connection error.';
      setLocalError(msg);
    } finally {
      setLoading(false);
    }
  };

  const handleDemoResident = async (demo: (typeof DEMO_RESIDENTS)[number]) => {
    setEmail(demo.email);
    setPassword(demo.password);
    setLoading(true);
    setLocalError(null);
    try {
      setApiUrl(apiUrl.trim());
      await demoLogin(demo.email, demo.password);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Login failed';
      setLocalError(msg);
    } finally {
      setLoading(false);
    }
  };

  const errorMessage = localError || authError;

  return (
    <KeyboardAvoidingView
      style={styles.keyboardContainer}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView
        contentContainerStyle={styles.scrollContainer}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.card}>
          {/* Brand Logo & Header */}
          <View style={styles.brandHeader}>
            <View style={styles.brandMark}>
              <View style={styles.brandMarkInner} />
            </View>
            <Text style={styles.brandTitle}>SocietyOS</Text>
            <Text style={styles.brandSubtitle}>Residential Operations & Gate Security</Text>
          </View>

          {/* Intro Box */}
          <View style={styles.welcomeBox}>
            <Text style={styles.welcomeTitle}>Resident Sign In</Text>
            <Text style={styles.welcomeText}>
              Manage family passes, invite guests with instant PINs, and view society notices.
            </Text>
          </View>

          {/* Error Notice */}
          {errorMessage ? (
            <View style={styles.errorBox}>
              <Text style={styles.errorText}>⚠️ {errorMessage}</Text>
            </View>
          ) : null}

          {/* Form Fields */}
          <View style={styles.formGroup}>
            <Text style={styles.label}>EMAIL ADDRESS</Text>
            <TextInput
              style={styles.input}
              placeholder="resident@societyos.dev"
              placeholderTextColor={colors.textMutedLight}
              autoCapitalize="none"
              keyboardType="email-address"
              value={email}
              onChangeText={setEmail}
            />
          </View>

          <View style={styles.formGroup}>
            <Text style={styles.label}>PASSWORD</Text>
            <TextInput
              style={styles.input}
              placeholder="••••••••••••"
              placeholderTextColor={colors.textMutedLight}
              secureTextEntry
              value={password}
              onChangeText={setPassword}
            />
          </View>

          {/* Sign In Button */}
          <TouchableOpacity
            style={[styles.signInButton, loading && styles.signInButtonDisabled]}
            onPress={() => void handleLogin()}
            disabled={loading}
            activeOpacity={0.85}
          >
            {loading ? (
              <ActivityIndicator color={colors.primaryText} />
            ) : (
              <Text style={styles.signInButtonText}>Sign In to Resident Portal →</Text>
            )}
          </TouchableOpacity>

          {/* Quick Demo Logins */}
          <View style={styles.demoSection}>
            <Text style={styles.demoLabel}>⚡ 1-TAP DEMO RESIDENT LOGINS</Text>
            <View style={styles.demoButtonsRow}>
              {DEMO_RESIDENTS.map((demo) => (
                <TouchableOpacity
                  key={demo.email}
                  style={styles.demoButton}
                  onPress={() => void handleDemoResident(demo)}
                  disabled={loading}
                >
                  <Text style={styles.demoButtonText}>{demo.label}</Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>

          {/* Backend API URL Settings */}
          <View style={styles.configSection}>
            <TouchableOpacity
              onPress={() => setShowConfig((prev) => !prev)}
              style={styles.configToggle}
            >
              <Text style={styles.configToggleText}>
                {showConfig ? '▼ Hide Server Settings' : '▶ Configure Backend API Endpoint'}
              </Text>
            </TouchableOpacity>

            {showConfig ? (
              <View style={styles.configBox}>
                <Text style={styles.configLabel}>BACKEND API URL</Text>
                <TextInput
                  style={styles.configInput}
                  value={apiUrl}
                  onChangeText={setLocalApiUrl}
                  autoCapitalize="none"
                  autoCorrect={false}
                />
                <Text style={styles.configHelp}>
                  Default: http://localhost:80/api/v1 (use LAN IP for physical phone)
                </Text>
              </View>
            ) : null}
          </View>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  keyboardContainer: {
    flex: 1,
    backgroundColor: colors.background,
  },
  scrollContainer: {
    flexGrow: 1,
    justifyContent: 'center',
    padding: 20,
    backgroundColor: colors.background,
  },
  card: {
    backgroundColor: colors.paper,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    padding: 24,
    shadowColor: colors.ink,
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.1,
    shadowRadius: 16,
    elevation: 4,
  },
  brandHeader: {
    alignItems: 'center',
    marginBottom: 20,
  },
  brandMark: {
    width: 44,
    height: 44,
    borderRadius: 12,
    backgroundColor: colors.ink,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 8,
  },
  brandMarkInner: {
    width: 20,
    height: 20,
    borderRadius: 5,
    backgroundColor: colors.amber,
  },
  brandTitle: {
    fontSize: 26,
    fontWeight: '700',
    color: colors.ink,
    fontFamily: 'Georgia',
    letterSpacing: -0.5,
  },
  brandSubtitle: {
    fontSize: 12,
    color: colors.textMuted,
    fontWeight: '500',
    marginTop: 2,
  },
  welcomeBox: {
    backgroundColor: colors.fog,
    borderRadius: 12,
    padding: 14,
    marginBottom: 18,
    borderWidth: 1,
    borderColor: colors.border,
  },
  welcomeTitle: {
    fontSize: 14,
    fontWeight: '700',
    color: colors.ink,
    marginBottom: 4,
  },
  welcomeText: {
    fontSize: 12,
    color: colors.charcoal,
    lineHeight: 17,
  },
  errorBox: {
    backgroundColor: '#ffe4e6',
    borderWidth: 1,
    borderColor: '#fecdd3',
    padding: 12,
    borderRadius: 10,
    marginBottom: 16,
  },
  errorText: {
    color: '#9f1239',
    fontSize: 13,
    fontWeight: '600',
  },
  formGroup: {
    marginBottom: 16,
  },
  label: {
    fontSize: 11,
    fontWeight: '800',
    color: colors.charcoal,
    letterSpacing: 0.8,
    marginBottom: 6,
  },
  input: {
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: colors.borderStrong,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 14,
    color: colors.ink,
  },
  signInButton: {
    backgroundColor: colors.primary,
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 6,
    shadowColor: colors.ink,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.2,
    shadowRadius: 8,
    elevation: 3,
  },
  signInButtonDisabled: {
    opacity: 0.7,
  },
  signInButtonText: {
    color: colors.primaryText,
    fontSize: 15,
    fontWeight: '700',
  },
  demoSection: {
    marginTop: 24,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    paddingTop: 16,
  },
  demoLabel: {
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 1,
    color: colors.amberInk,
    marginBottom: 8,
  },
  demoButtonsRow: {
    gap: 8,
  },
  demoButton: {
    backgroundColor: colors.fog,
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    alignItems: 'center',
  },
  demoButtonText: {
    fontSize: 12,
    fontWeight: '700',
    color: colors.ink,
  },
  configSection: {
    marginTop: 20,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    paddingTop: 12,
  },
  configToggle: {
    alignItems: 'center',
    paddingVertical: 4,
  },
  configToggleText: {
    fontSize: 11,
    color: colors.textMuted,
    fontWeight: '600',
  },
  configBox: {
    marginTop: 10,
    backgroundColor: colors.fog,
    padding: 12,
    borderRadius: 8,
  },
  configLabel: {
    fontSize: 10,
    fontWeight: '700',
    color: colors.charcoal,
    marginBottom: 4,
  },
  configInput: {
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
    fontSize: 12,
    color: colors.ink,
  },
  configHelp: {
    fontSize: 10,
    color: colors.textMuted,
    marginTop: 4,
  },
});
