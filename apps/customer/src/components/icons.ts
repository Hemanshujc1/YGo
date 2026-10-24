import { Briefcase, ChevronDown, ChevronLeft, House, LogOut, Mail, Map, MapPin, Phone, Search, User } from "lucide-react-native";
import { cssInterop } from "nativewind";

// An icon takes its colour from a text class, such as `text-muted`.
for (const icon of [Briefcase, ChevronDown, ChevronLeft, House, LogOut, Mail, Map, MapPin, Phone, Search, User]) {
  cssInterop(icon, { className: { target: "style", nativeStyleToProp: { color: true } } });
}

export { Briefcase, ChevronDown, ChevronLeft, House, LogOut, Mail, Map, MapPin, Phone, Search, User };
