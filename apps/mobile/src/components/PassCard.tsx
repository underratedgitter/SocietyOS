import React, { useState } from 'react';
import {
  Alert,
  Linking,
  Share,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { colors } from '../styles/theme';
import type { PassView, PassWithCredentials } from '../api/types';
import {
  buildPassShareText,
  buildWhatsAppShareUrl,
  categoryLabel,
  formatWindow,
} from '../utils/format';
import { getApiUrl } from '../api/client';
import { QRCodeView } from './QRCodeView';
import { PassBadge } from './PassBadge';

export interface PassCardProps {
  passData:
    | PassWithCredentials
    | { pass: PassView; credentials?: { pin?: string; qrToken?: string } | null };
  timezone?: string;
  onClose?: () => void;
  meta?: { vehicle?: string; purpose?: string } | null;
}

export function PassCard({ passData, timezone, onClose, meta }: PassCardProps) {
  const [copiedPin, setCopiedPin] = useState(false);
  const { pass, credentials } = passData;

  // Extract clean guest name and vehicle
  const rawName = pass.visitor.name;
  const vehicleMatch = rawName.match(/\[(.*?)\]/);
  const vehicle = meta?.vehicle || (vehicleMatch ? vehicleMatch[1] : undefined);
  const guestName = rawName.replace(/\s*\[.*?\]/, '').trim();
  const purpose = meta?.purpose;

  const hasPin = Boolean(credentials?.pin);
  const hasQr = Boolean(credentials?.qrToken);

  const shareText = buildPassShareText({
    guestName,
    phone: pass.visitor.phone,
    vehicle,
    category: pass.category,
    purpose,
    building: pass.flat.building,
    flatNumber: pass.flat.flatNumber,
    validFrom: pass.validFrom,
    validUntil: pass.validUntil,
    pin: credentials?.pin,
    passId: pass.id,
    apiUrl: getApiUrl(),
    timezone,
  });

  const handleWhatsAppShare = async () => {
    const whatsappUrl = buildWhatsAppShareUrl(shareText, pass.visitor.phone);
    try {
      const supported = await Linking.canOpenURL(whatsappUrl);
      if (supported) {
        await Linking.openURL(whatsappUrl);
      } else {
        await handleNativeShare();
      }
    } catch {
      await handleNativeShare();
    }
  };

  const handleNativeShare = async () => {
    try {
      await Share.share({
        title: `SocietyOS Pass: ${guestName}`,
        message: shareText,
      });
    } catch {
      Alert.alert('Share Error', 'Could not open share sheet');
    }
  };

  const handleCopyPin = () => {
    if (credentials?.pin) {
      setCopiedPin(true);
      setTimeout(() => setCopiedPin(false), 2500);
      Alert.alert('PIN Copied', `PIN: ${credentials.pin}\nShare this with your guest for gate entry.`);
    } else {
      Alert.alert(
        'PIN Protected',
        'For security, the access PIN is displayed only at creation time. Create a new pass if a new PIN is required.',
      );
    }
  };

  const qrValue = credentials?.qrToken || `SOCIETYOS:PASS:${pass.id}:${pass.societyId}`;

  return (
    <View style={styles.cardContainer}>
      {/* Decorative top amber ticket border */}
      <View style={styles.ticketTopBar} />

      {/* Top Header */}
      <View style={styles.cardHeader}>
        <View style={styles.headerLeft}>
          <Text style={styles.eyebrow}>VISITOR CREDENTIAL</Text>
          <Text style={styles.guestName}>{guestName}</Text>
          {vehicle ? (
            <View style={styles.vehicleChip}>
              <Text style={styles.vehicleText}>🚗 {vehicle}</Text>
            </View>
          ) : null}
        </View>
        <View style={styles.headerRight}>
          <PassBadge status={pass.effectiveStatus} />
          <View style={styles.categoryChip}>
            <Text style={styles.categoryChipText}>{categoryLabel(pass.category)}</Text>
          </View>
        </View>
      </View>

      {/* Perforation Line with Cutouts */}
      <View style={styles.perforationWrapper}>
        <View style={styles.cutoutLeft} />
        <View style={styles.dashedLine} />
        <View style={styles.cutoutRight} />
      </View>

      {/* Hero PIN Box */}
      <View style={[styles.pinHero, !hasPin && styles.pinHeroInactive]}>
        <Text style={styles.pinLabel}>GATE ACCESS PIN</Text>
        <Text style={[styles.pinNumber, !hasPin && styles.pinNumberHidden]}>
          {hasPin ? credentials!.pin : '••••••'}
        </Text>
        <Text style={styles.pinInstruction}>
          {hasPin
            ? 'Touch 6-digit PIN on gate kiosk keypad'
            : 'PIN issued at creation. Hashed securely for resident safety.'}
        </Text>
      </View>

      {/* QR Code Section */}
      <View style={styles.qrSection}>
        <QRCodeView value={qrValue} size={150} />
        <Text style={styles.qrInstruction}>
          {hasQr
            ? 'Scan directly under kiosk camera for contactless entry'
            : 'Gate verification QR code token'}
        </Text>
      </View>

      {/* Details Grid */}
      <View style={styles.detailsGrid}>
        <View style={styles.detailBlock}>
          <Text style={styles.detailLabel}>DESTINATION</Text>
          <Text style={styles.detailValue}>
            {pass.flat.building} · Flat {pass.flat.flatNumber}
          </Text>
        </View>
        <View style={styles.detailBlock}>
          <Text style={styles.detailLabel}>GATES ALLOWED</Text>
          <Text style={styles.detailValue}>
            {pass.accessPoints.map((g) => g.name).join(', ') || 'All Gates'}
          </Text>
        </View>
        <View style={[styles.detailBlock, { borderBottomWidth: 0 }]}>
          <Text style={styles.detailLabel}>VALIDITY WINDOW</Text>
          <Text style={styles.detailValue}>{formatWindow(pass.validFrom, pass.validUntil, timezone)}</Text>
        </View>
      </View>

      {/* Action Buttons */}
      <View style={styles.actionRow}>
        <TouchableOpacity style={styles.whatsappButton} onPress={handleWhatsAppShare} activeOpacity={0.85}>
          <Text style={styles.whatsappButtonText}>💬 WhatsApp Pass</Text>
        </TouchableOpacity>

        <TouchableOpacity style={styles.shareButton} onPress={handleNativeShare} activeOpacity={0.85}>
          <Text style={styles.shareButtonText}>↗️ Share Sheet</Text>
        </TouchableOpacity>
      </View>

      <View style={styles.secondaryActions}>
        {hasPin ? (
          <TouchableOpacity style={styles.copyButton} onPress={handleCopyPin}>
            <Text style={styles.copyButtonText}>{copiedPin ? '✓ PIN Copied' : '📋 Copy PIN'}</Text>
          </TouchableOpacity>
        ) : null}
        {onClose ? (
          <TouchableOpacity style={styles.closeButton} onPress={onClose}>
            <Text style={styles.closeButtonText}>Done</Text>
          </TouchableOpacity>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  cardContainer: {
    backgroundColor: colors.paper,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    shadowColor: colors.ink,
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.12,
    shadowRadius: 18,
    elevation: 4,
    marginVertical: 12,
    overflow: 'hidden',
  },
  ticketTopBar: {
    height: 4,
    backgroundColor: colors.amber,
  },
  cardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    padding: 18,
    backgroundColor: '#FFFFFF',
  },
  headerLeft: {
    flex: 1,
    paddingRight: 10,
  },
  eyebrow: {
    fontSize: 10,
    fontWeight: '800',
    color: colors.textMuted,
    letterSpacing: 1.2,
    marginBottom: 4,
  },
  guestName: {
    fontSize: 22,
    fontWeight: '700',
    color: colors.ink,
    fontFamily: 'Georgia',
  },
  vehicleChip: {
    backgroundColor: colors.fog,
    alignSelf: 'flex-start',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
    marginTop: 6,
    borderWidth: 1,
    borderColor: colors.border,
  },
  vehicleText: {
    fontSize: 12,
    fontWeight: '700',
    color: colors.ink,
  },
  headerRight: {
    alignItems: 'flex-end',
    gap: 6,
  },
  categoryChip: {
    backgroundColor: colors.fog,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: colors.border,
  },
  categoryChipText: {
    fontSize: 11,
    fontWeight: '600',
    color: colors.textMuted,
  },
  perforationWrapper: {
    position: 'relative',
    height: 24,
    backgroundColor: colors.paper,
    justifyContent: 'center',
    overflow: 'hidden',
  },
  cutoutLeft: {
    position: 'absolute',
    left: -12,
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: colors.background,
    borderWidth: 1,
    borderColor: colors.borderStrong,
  },
  cutoutRight: {
    position: 'absolute',
    right: -12,
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: colors.background,
    borderWidth: 1,
    borderColor: colors.borderStrong,
  },
  dashedLine: {
    marginHorizontal: 20,
    borderStyle: 'dashed',
    borderWidth: 1,
    borderColor: colors.borderDark,
    borderRadius: 1,
  },
  pinHero: {
    backgroundColor: colors.fog,
    marginHorizontal: 16,
    borderRadius: 12,
    padding: 16,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: colors.border,
  },
  pinHeroInactive: {
    backgroundColor: '#f3f4f6',
    borderColor: '#e5e7eb',
  },
  pinLabel: {
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1,
    color: colors.textMuted,
    marginBottom: 4,
  },
  pinNumber: {
    fontSize: 38,
    fontWeight: '800',
    letterSpacing: 8,
    color: colors.ink,
    fontFamily: 'Courier',
    marginVertical: 4,
  },
  pinNumberHidden: {
    fontSize: 26,
    letterSpacing: 4,
    color: colors.textMuted,
  },
  pinInstruction: {
    fontSize: 12,
    color: colors.textMuted,
  },
  qrSection: {
    alignItems: 'center',
    paddingVertical: 18,
  },
  qrInstruction: {
    fontSize: 12,
    color: colors.textMuted,
    marginTop: 8,
    fontWeight: '500',
  },
  detailsGrid: {
    backgroundColor: '#FFFFFF',
    borderTopWidth: 1,
    borderBottomWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  detailBlock: {
    paddingVertical: 6,
    borderBottomWidth: 1,
    borderBottomColor: colors.fog,
  },
  detailLabel: {
    fontSize: 10,
    fontWeight: '700',
    color: colors.textMuted,
    letterSpacing: 0.8,
    marginBottom: 2,
  },
  detailValue: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.ink,
  },
  actionRow: {
    flexDirection: 'row',
    gap: 10,
    padding: 16,
    paddingBottom: 8,
  },
  whatsappButton: {
    flex: 1.2,
    backgroundColor: colors.whatsapp,
    paddingVertical: 12,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: colors.whatsapp,
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.2,
    shadowRadius: 4,
    elevation: 2,
  },
  whatsappButtonText: {
    color: '#FFFFFF',
    fontWeight: '700',
    fontSize: 14,
  },
  shareButton: {
    flex: 1,
    backgroundColor: colors.primary,
    paddingVertical: 12,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  shareButtonText: {
    color: colors.primaryText,
    fontWeight: '700',
    fontSize: 14,
  },
  secondaryActions: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingBottom: 16,
  },
  copyButton: {
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: 8,
    backgroundColor: colors.fog,
    borderWidth: 1,
    borderColor: colors.border,
  },
  copyButtonText: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.ink,
  },
  closeButton: {
    paddingVertical: 8,
    paddingHorizontal: 16,
    borderRadius: 8,
    backgroundColor: colors.backgroundMuted,
  },
  closeButtonText: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.charcoal,
  },
});
