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
import type { PassWithCredentials } from '../api/types';
import { categoryLabel, formatWindow } from '../utils/format';
import { QRCodeView } from './QRCodeView';
import { PassBadge } from './PassBadge';

interface PassCardProps {
  passData: PassWithCredentials;
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

  const shareText = [
    '🏛️ *SocietyOS Visitor Pass*',
    `👤 *Guest:* ${guestName}`,
    pass.visitor.phone ? `📱 *Phone:* ${pass.visitor.phone}` : null,
    vehicle ? `🚗 *Vehicle:* ${vehicle}` : null,
    `🏷️ *Category:* ${categoryLabel(pass.category)}${purpose ? ` · ${purpose}` : ''}`,
    `📍 *Destination:* ${pass.flat.building} · Flat ${pass.flat.flatNumber}`,
    `⏱️ *Window:* ${formatWindow(pass.validFrom, pass.validUntil, timezone)}`,
    '',
    `🔑 *Gate Access PIN:* ${credentials.pin}`,
    '👉 Enter this 6-digit PIN on the gate kiosk keypad, or scan the QR token under the camera for direct contactless entry.',
  ]
    .filter(Boolean)
    .join('\n');

  const handleWhatsAppShare = async () => {
    const whatsappUrl = `https://wa.me/?text=${encodeURIComponent(shareText)}`;
    try {
      const supported = await Linking.canOpenURL(whatsappUrl);
      if (supported) {
        await Linking.openURL(whatsappUrl);
      } else {
        // Fallback to native share if WhatsApp app URL is not directly supported
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
    } catch (err) {
      Alert.alert('Share Error', 'Could not open share sheet');
    }
  };

  const handleCopyPin = () => {
    // Show user confirmation
    setCopiedPin(true);
    setTimeout(() => setCopiedPin(false), 2500);
    Alert.alert('PIN Copied', `PIN: ${credentials.pin}\nShare this with your guest for gate entry.`);
  };

  return (
    <View style={styles.cardContainer}>
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
      <View style={styles.pinHero}>
        <Text style={styles.pinLabel}>GATE ACCESS PIN</Text>
        <Text style={styles.pinNumber}>{credentials.pin}</Text>
        <Text style={styles.pinInstruction}>Touch 6-digit PIN on gate kiosk keypad</Text>
      </View>

      {/* QR Code Section */}
      <View style={styles.qrSection}>
        <QRCodeView value={credentials.qrToken} size={150} />
        <Text style={styles.qrInstruction}>Scan directly under kiosk camera</Text>
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
          <Text style={styles.whatsappButtonText}>💬 Share via WhatsApp</Text>
        </TouchableOpacity>

        <TouchableOpacity style={styles.shareButton} onPress={handleNativeShare} activeOpacity={0.85}>
          <Text style={styles.shareButtonText}>↗️ Share Pass</Text>
        </TouchableOpacity>
      </View>

      <View style={styles.secondaryActions}>
        <TouchableOpacity style={styles.copyButton} onPress={handleCopyPin}>
          <Text style={styles.copyButtonText}>{copiedPin ? '✓ PIN Copied' : '📋 Copy PIN'}</Text>
        </TouchableOpacity>
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
