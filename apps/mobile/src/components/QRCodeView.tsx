import { useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import Svg, { Path, Rect } from 'react-native-svg';
import QRCode from 'qrcode';
import { colors } from '../styles/theme';

interface QRCodeViewProps {
  value: string;
  size?: number;
}

export function QRCodeView({ value, size = 180 }: QRCodeViewProps) {
  const { path, moduleCount } = useMemo(() => {
    try {
      const qr = QRCode.create(value || 'SOCIETYOS', { errorCorrectionLevel: 'M' });
      const count = qr.modules.size;
      const data = qr.modules.data;

      let d = '';
      for (let row = 0; row < count; row++) {
        for (let col = 0; col < count; col++) {
          if (data[row * count + col]) {
            d += `M${col},${row}h1v1h-1z `;
          }
        }
      }

      return { path: d, moduleCount: count };
    } catch {
      return { path: '', moduleCount: 21 };
    }
  }, [value]);

  const padding = 2; // quiet zone in module units
  const totalUnits = moduleCount + padding * 2;

  return (
    <View style={[styles.container, { width: size + 20, height: size + 20 }]}>
      <Svg
        viewBox={`-${padding} -${padding} ${totalUnits} ${totalUnits}`}
        width={size}
        height={size}
      >
        <Rect
          x={-padding}
          y={-padding}
          width={totalUnits}
          height={totalUnits}
          fill="#FFFFFF"
        />
        <Path d={path} fill={colors.ink} />
      </Svg>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: '#FFFFFF',
    padding: 10,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: colors.ink,
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.06,
    shadowRadius: 6,
    elevation: 2,
  },
});
