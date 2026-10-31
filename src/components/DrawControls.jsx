import { useEffect } from "react";
import { useMap } from "react-leaflet";
import "@geoman-io/leaflet-geoman-free";
import "@geoman-io/leaflet-geoman-free/dist/leaflet-geoman.css";

// Wires up Leaflet-Geoman drawing controls on the map and reports the
// current plot polygon (as an array of {lat, lng}) up to the parent
// whenever it's created, edited, or removed.
export default function DrawControls({ onPolygonChange }) {
  const map = useMap();

  useEffect(() => {
    map.pm.addControls({
      position: "topleft",
      drawMarker: false,
      drawCircleMarker: false,
      drawPolyline: false,
      drawRectangle: true,
      drawPolygon: true,
      drawCircle: false,
      drawText: false,
      editMode: true,
      dragMode: true,
      cutPolygon: true,
      removalMode: true,
      rotateMode: false,
    });

    map.pm.setPathOptions({
      color: "#06c167",
      fillColor: "#06c167",
      fillOpacity: 0.25,
      weight: 3,
    });

    let currentLayer = null;

    const reportPolygon = (layer) => {
      const latLngs = layer.getLatLngs()[0].map((p) => ({ lat: p.lat, lng: p.lng }));
      onPolygonChange(latLngs, layer);
    };

    const handleCreate = (e) => {
      // Only keep one plot at a time for the MVP — remove any previous shape.
      if (currentLayer && currentLayer !== e.layer) {
        map.removeLayer(currentLayer);
      }
      currentLayer = e.layer;
      reportPolygon(currentLayer);

      currentLayer.on("pm:edit", () => reportPolygon(currentLayer));
      currentLayer.on("pm:markerdragend", () => reportPolygon(currentLayer));
      currentLayer.on("pm:cut", (cutEvent) => {
        currentLayer = cutEvent.layer;
        reportPolygon(currentLayer);
      });
    };

    const handleRemove = (e) => {
      if (e.layer === currentLayer) {
        currentLayer = null;
        onPolygonChange(null, null);
      }
    };

    map.on("pm:create", handleCreate);
    map.on("pm:remove", handleRemove);

    return () => {
      map.off("pm:create", handleCreate);
      map.off("pm:remove", handleRemove);
      map.pm.removeControls();
    };
  }, [map, onPolygonChange]);

  return null;
}
