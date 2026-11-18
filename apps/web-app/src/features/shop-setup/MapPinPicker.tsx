import { useState } from 'react';
import L from 'leaflet';
import markerIcon2x from 'leaflet/dist/images/marker-icon-2x.png';
import markerIcon from 'leaflet/dist/images/marker-icon.png';
import markerShadow from 'leaflet/dist/images/marker-shadow.png';
import { MapContainer, Marker, TileLayer, useMapEvents } from 'react-leaflet';
import 'leaflet/dist/leaflet.css';

// Ensure Leaflet marker assets resolve cleanly when bundled by Vite
L.Icon.Default.mergeOptions({
  iconRetinaUrl: markerIcon2x,
  iconUrl: markerIcon,
  shadowUrl: markerShadow,
});

interface MapPinPickerProps {
  initialLat?: number;
  initialLng?: number;
  onLocationSelect: (lat: number, lng: number) => void;
}

interface LocationMarkerProps {
  position: [number, number] | null;
  onSelect: (lat: number, lng: number) => void;
}

function LocationMarker({ position, onSelect }: LocationMarkerProps) {
  useMapEvents({
    click(event) {
      const lat = Number(event.latlng.lat.toFixed(6));
      const lng = Number(event.latlng.lng.toFixed(6));
      onSelect(lat, lng);
    },
  });

  return position ? <Marker position={position} /> : null;
}

export function MapPinPicker({
  initialLat = 20.5937,
  initialLng = 78.9629,
  onLocationSelect,
}: MapPinPickerProps) {
  const [selectedPos, setSelectedPos] = useState<[number, number] | null>([initialLat, initialLng]);

  const handleSelect = (lat: number, lng: number) => {
    setSelectedPos([lat, lng]);
    onLocationSelect(lat, lng);
  };

  return (
    <div className="space-y-2">
      <div className="h-64 w-full overflow-hidden rounded-md border border-slate-300">
        <MapContainer
          center={[initialLat, initialLng]}
          zoom={5}
          scrollWheelZoom={true}
          className="h-full w-full"
        >
          <TileLayer
            attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          />
          <LocationMarker position={selectedPos} onSelect={handleSelect} />
        </MapContainer>
      </div>
      <p className="text-xs text-slate-600">
        {selectedPos
          ? `Pinned location: ${selectedPos[0].toFixed(6)}, ${selectedPos[1].toFixed(6)} (tap map to move pin)`
          : 'Tap anywhere on the map to pin your kirana shop location.'}
      </p>
    </div>
  );
}
