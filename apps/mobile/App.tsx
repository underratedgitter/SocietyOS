import { useState } from 'react';
import {
  ActivityIndicator,
  SafeAreaView,
  StatusBar,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { Header } from './src/components/Header';
import { AuthProvider, useAuth } from './src/context/AuthContext';
import { HomeScreen } from './src/screens/HomeScreen';
import { LoginScreen } from './src/screens/LoginScreen';
import { NoticesScreen } from './src/screens/NoticesScreen';
import { RelativesScreen } from './src/screens/RelativesScreen';
import { colors } from './src/styles/theme';

function MainNavigator() {
  const { session, loading } = useAuth();
  const [activeTab, setActiveTab] = useState<'passes' | 'relatives' | 'notices'>('passes');
  const [registerModalOpen, setRegisterModalOpen] = useState(false);

  if (loading) {
    return (
      <View style={styles.splashContainer}>
        <View style={styles.splashBrandMark}>
          <View style={styles.splashBrandMarkInner} />
        </View>
        <Text style={styles.splashTitle}>SocietyOS</Text>
        <Text style={styles.splashSubtitle}>Residential Operations & Security</Text>
        <ActivityIndicator
          size="small"
          color={colors.ink}
          style={{ marginTop: 24 }}
        />
      </View>
    );
  }

  if (!session) {
    return <LoginScreen />;
  }

  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar barStyle="dark-content" backgroundColor={colors.background} />
      <Header
        activeTab={activeTab}
        onTabChange={setActiveTab}
        onRegisterPress={() => setRegisterModalOpen(true)}
      />
      {activeTab === 'passes' ? (
        <HomeScreen
          registerModalOpen={registerModalOpen}
          setRegisterModalOpen={setRegisterModalOpen}
        />
      ) : activeTab === 'relatives' ? (
        <RelativesScreen />
      ) : (
        <NoticesScreen />
      )}
    </SafeAreaView>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <MainNavigator />
    </AuthProvider>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: colors.background,
  },
  splashContainer: {
    flex: 1,
    backgroundColor: colors.background,
    alignItems: 'center',
    justifyContent: 'center',
  },
  splashBrandMark: {
    width: 60,
    height: 60,
    borderRadius: 16,
    backgroundColor: colors.ink,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 12,
  },
  splashBrandMarkInner: {
    width: 28,
    height: 28,
    borderRadius: 6,
    backgroundColor: colors.amber,
  },
  splashTitle: {
    fontSize: 32,
    fontWeight: '700',
    color: colors.ink,
    fontFamily: 'Georgia',
    letterSpacing: -0.5,
  },
  splashSubtitle: {
    fontSize: 13,
    color: colors.textMuted,
    marginTop: 4,
  },
});
