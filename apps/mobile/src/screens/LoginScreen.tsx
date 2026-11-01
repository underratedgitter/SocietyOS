import React, { useEffect, useState } from 'react';
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
import { api, ApiError, getApiUrl, setApiUrl } from '../api/client';
import { mobileStorage } from '../api/storage';
import type { PublicFlat, PublicSociety } from '../api/types';
import { DEMO_RESIDENTS, useAuth } from '../context/AuthContext';
import { colors } from '../styles/theme';

export function LoginScreen() {
  const { login, demoLogin, register, error: authError } = useAuth();
  const [mode, setMode] = useState<'login' | 'register'>('login');

  // Sign In State
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  // Register State
  const [regName, setRegName] = useState('');
  const [regEmail, setRegEmail] = useState('');
  const [regPassword, setRegPassword] = useState('');
  const [regPhone, setRegPhone] = useState('');
  const [regRelationship, setRegRelationship] = useState<'OWNER' | 'TENANT' | 'FAMILY'>('OWNER');
  const [societies, setSocieties] = useState<PublicSociety[]>([]);
  const [selectedSocietyId, setSelectedSocietyId] = useState('');
  const [flats, setFlats] = useState<PublicFlat[]>([]);
  const [selectedFlatId, setSelectedFlatId] = useState('');
  const [loadingDirectories, setLoadingDirectories] = useState(false);

  const [loading, setLoading] = useState(false);
  const [apiUrl, setLocalApiUrl] = useState(getApiUrl());
  const [showConfig, setShowConfig] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      const saved = await mobileStorage.loadApiUrl();
      if (saved) {
        setLocalApiUrl(saved);
        setApiUrl(saved);
      }
    })();
  }, []);

  // Fetch societies when entering register mode
  useEffect(() => {
    if (mode === 'register' && societies.length === 0) {
      setLoadingDirectories(true);
      api
        .listPublicSocieties()
        .then((list) => {
          setSocieties(list);
          if (list.length > 0) {
            setSelectedSocietyId(list[0].id);
          }
        })
        .catch(() => {
          // Keep empty if network unreachable
        })
        .finally(() => setLoadingDirectories(false));
    }
  }, [mode, societies.length]);

  // Fetch flats when selected society changes
  useEffect(() => {
    if (selectedSocietyId) {
      api
        .listPublicFlats(selectedSocietyId)
        .then((flatList) => {
          setFlats(flatList);
          if (flatList.length > 0) {
            setSelectedFlatId(flatList[0].id);
          }
        })
        .catch(() => {
          setFlats([]);
        });
    }
  }, [selectedSocietyId]);

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

  const handleRegister = async () => {
    setLocalError(null);
    if (!regName.trim() || !regEmail.trim() || !regPassword) {
      setLocalError('Please enter your full name, email, and password.');
      return;
    }
    if (regPassword.length < 8) {
      setLocalError('Password must be at least 8 characters long.');
      return;
    }
    if (!selectedSocietyId) {
      setLocalError('Please select your residential society.');
      return;
    }

    setLoading(true);
    try {
      setApiUrl(apiUrl.trim());
      await register({
        name: regName.trim(),
        email: regEmail.trim().toLowerCase(),
        password: regPassword,
        phone: regPhone.trim() || undefined,
        societyId: selectedSocietyId,
        flatId: selectedFlatId || undefined,
        relationship: regRelationship,
      });
    } catch (err: unknown) {
      const msg = err instanceof ApiError ? err.message : 'Registration failed. Please check details.';
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

          {/* Mode Switcher Tabs */}
          <View style={styles.modeTabBar}>
            <TouchableOpacity
              style={[styles.modeTab, mode === 'login' && styles.modeTabActive]}
              onPress={() => {
                setMode('login');
                setLocalError(null);
              }}
            >
              <Text style={[styles.modeTabText, mode === 'login' && styles.modeTabTextActive]}>
                Sign In
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.modeTab, mode === 'register' && styles.modeTabActive]}
              onPress={() => {
                setMode('register');
                setLocalError(null);
              }}
            >
              <Text style={[styles.modeTabText, mode === 'register' && styles.modeTabTextActive]}>
                Register Flat
              </Text>
            </TouchableOpacity>
          </View>

          {/* Intro Box */}
          <View style={styles.welcomeBox}>
            <Text style={styles.welcomeTitle}>
              {mode === 'login' ? 'Resident Sign In' : 'Resident Self-Registration'}
            </Text>
            <Text style={styles.welcomeText}>
              {mode === 'login'
                ? 'Manage family passes, invite guests with instant PINs, and view society notices.'
                : 'Link your apartment flat and create a secure resident profile for instant gate credentials.'}
            </Text>
          </View>

          {/* Error Notice */}
          {errorMessage ? (
            <View style={styles.errorBox}>
              <Text style={styles.errorText}>⚠️ {errorMessage}</Text>
            </View>
          ) : null}

          {mode === 'login' ? (
            <>
              {/* Form Fields for Login */}
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
            </>
          ) : (
            <>
              {/* Form Fields for Self-Registration */}
              <View style={styles.formGroup}>
                <Text style={styles.label}>FULL NAME</Text>
                <TextInput
                  style={styles.input}
                  placeholder="e.g. Sunil Patel"
                  placeholderTextColor={colors.textMutedLight}
                  value={regName}
                  onChangeText={setRegName}
                />
              </View>

              <View style={styles.formGroup}>
                <Text style={styles.label}>EMAIL ADDRESS</Text>
                <TextInput
                  style={styles.input}
                  placeholder="e.g. sunil@societyos.dev"
                  placeholderTextColor={colors.textMutedLight}
                  autoCapitalize="none"
                  keyboardType="email-address"
                  value={regEmail}
                  onChangeText={setRegEmail}
                />
              </View>

              <View style={styles.formGroup}>
                <Text style={styles.label}>PASSWORD (MIN 8 CHARS)</Text>
                <TextInput
                  style={styles.input}
                  placeholder="••••••••••••"
                  placeholderTextColor={colors.textMutedLight}
                  secureTextEntry
                  value={regPassword}
                  onChangeText={setRegPassword}
                />
              </View>

              <View style={styles.formGroup}>
                <Text style={styles.label}>MOBILE PHONE (OPTIONAL)</Text>
                <TextInput
                  style={styles.input}
                  placeholder="+91 98765 43210"
                  placeholderTextColor={colors.textMutedLight}
                  keyboardType="phone-pad"
                  value={regPhone}
                  onChangeText={setRegPhone}
                />
              </View>

              {/* Residential Society Selector */}
              <View style={styles.formGroup}>
                <Text style={styles.label}>SELECT SOCIETY</Text>
                {loadingDirectories ? (
                  <ActivityIndicator size="small" color={colors.ink} style={{ marginVertical: 8 }} />
                ) : (
                  <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.pillScroll}>
                    {societies.map((s) => {
                      const active = selectedSocietyId === s.id;
                      return (
                        <TouchableOpacity
                          key={s.id}
                          style={[styles.pill, active && styles.pillActive]}
                          onPress={() => setSelectedSocietyId(s.id)}
                        >
                          <Text style={[styles.pillText, active && styles.pillTextActive]}>{s.name}</Text>
                        </TouchableOpacity>
                      );
                    })}
                  </ScrollView>
                )}
              </View>

              {/* Flat Selector */}
              {flats.length > 0 ? (
                <View style={styles.formGroup}>
                  <Text style={styles.label}>SELECT FLAT / UNIT</Text>
                  <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.pillScroll}>
                    {flats.map((f) => {
                      const active = selectedFlatId === f.id;
                      return (
                        <TouchableOpacity
                          key={f.id}
                          style={[styles.pill, active && styles.pillActive]}
                          onPress={() => setSelectedFlatId(f.id)}
                        >
                          <Text style={[styles.pillText, active && styles.pillTextActive]}>{f.label}</Text>
                        </TouchableOpacity>
                      );
                    })}
                  </ScrollView>
                </View>
              ) : null}

              {/* Relationship Pills */}
              <View style={styles.formGroup}>
                <Text style={styles.label}>RESIDENT RELATIONSHIP</Text>
                <View style={styles.pillRow}>
                  {(['OWNER', 'TENANT', 'FAMILY'] as const).map((rel) => {
                    const active = regRelationship === rel;
                    return (
                      <TouchableOpacity
                        key={rel}
                        style={[styles.pill, active && styles.pillActive]}
                        onPress={() => setRegRelationship(rel)}
                      >
                        <Text style={[styles.pillText, active && styles.pillTextActive]}>{rel}</Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>
              </View>

              {/* Register Button */}
              <TouchableOpacity
                style={[styles.signInButton, loading && styles.signInButtonDisabled]}
                onPress={() => void handleRegister()}
                disabled={loading}
                activeOpacity={0.85}
              >
                {loading ? (
                  <ActivityIndicator color={colors.primaryText} />
                ) : (
                  <Text style={styles.signInButtonText}>Create Account & Sign In →</Text>
                )}
              </TouchableOpacity>
            </>
          )}

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
    marginBottom: 16,
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
  modeTabBar: {
    flexDirection: 'row',
    backgroundColor: colors.fog,
    borderRadius: 10,
    padding: 4,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: colors.border,
  },
  modeTab: {
    flex: 1,
    paddingVertical: 8,
    alignItems: 'center',
    borderRadius: 7,
  },
  modeTabActive: {
    backgroundColor: '#FFFFFF',
    shadowColor: colors.ink,
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.08,
    shadowRadius: 2,
    elevation: 1,
  },
  modeTabText: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.textMuted,
  },
  modeTabTextActive: {
    color: colors.ink,
    fontWeight: '700',
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
    marginBottom: 14,
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
  pillScroll: {
    flexDirection: 'row',
    marginBottom: 4,
  },
  pillRow: {
    flexDirection: 'row',
    gap: 8,
  },
  pill: {
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 8,
    backgroundColor: colors.fog,
    borderWidth: 1,
    borderColor: colors.border,
    marginRight: 8,
  },
  pillActive: {
    backgroundColor: colors.ink,
    borderColor: colors.ink,
  },
  pillText: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.charcoal,
  },
  pillTextActive: {
    color: '#FFFFFF',
    fontWeight: '700',
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
    marginTop: 20,
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
