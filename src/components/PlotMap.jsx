import { useEffect } from "react";
import { MapContainer, TileLayer, LayersControl, useMap } from "react-leaflet";
import "leaflet/dist/leaflet.css";
import DrawControls from "./DrawControls";

function FlyTo({ location }) {
  const map = useMap();
  useEffect(() => {
    if (location) {
      map.flyTo([location.lat, location.lng], 17);
    }
  }, [location, map]);
  return null;
}

export default function PlotMap({ flyToLocation, onPolygonChange }) {
  return (
    <MapContainer
      center={[26.4499, 80.3319]} // roughly central India/Nepal border region as a default view
      zoom={6}
      className="plot-map"
    >
      <LayersControl position="topright">
        <LayersControl.BaseLayer checked name="Satellite (Esri)">
          <TileLayer
            attribution="Tiles &copy; Esri — Source: Esri, Maxar, Earthstar Geographics"
            url="https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"
            maxZoom={19}
          />
        </LayersControl.BaseLayer>
        <LayersControl.BaseLayer name="Street Map (OSM)">
          <TileLayer
            attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
            url="https://tile.openstreetmap.org/{z}/{x}/{y}.png"
            maxZoom={19}
          />
        </LayersControl.BaseLayer>
        <LayersControl.Overlay checked name="Place labels">
          <TileLayer
            attribution="Labels &copy; Esri"
            url="https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}"
            maxZoom={19}
          />
        </LayersControl.Overlay>
      </LayersControl>

      <FlyTo location={flyToLocation} />
      <DrawControls onPolygonChange={onPolygonChange} />
    </MapContainer>
  );
}
