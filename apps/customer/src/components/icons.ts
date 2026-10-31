import { colourIcons } from "@ygo/mobile";
import {
  Briefcase, ChevronDown, ChevronLeft, House, ImageIcon, LogOut, Mail, Map, MapPin, Minus, Phone, Plus, Search, Trash2, User,
} from "lucide-react-native";
import Svg from "react-native-svg";

colourIcons(Briefcase, ChevronDown, ChevronLeft, House, ImageIcon, LogOut, Mail, Map, MapPin, Minus, Phone, Plus, Search, Trash2, User);
// The Order placed check mark draws in `currentColor` from a text class (#427).
colourIcons(Svg);

export {
  Briefcase, ChevronDown, ChevronLeft, House, ImageIcon, LogOut, Mail, Map, MapPin, Minus, Phone, Plus, Search, Trash2, User,
};
